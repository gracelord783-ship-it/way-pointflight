const STATUSES = ['Ticket Created', 'Ticket Confirmed', 'Check-in Open', 'Boarding', 'Departed', 'In Transit', 'Delayed', 'Landed', 'Arrived', 'Completed', 'Cancelled'];
const CHART_COLORS = ['#76afd2', '#85bb77', '#a197df', '#d5a45c', '#62afaa', '#6f91c3', '#db8c59', '#6eafd0', '#81b593', '#567f68', '#d57973'];
const SECTIONS = { overview: 'Overview', tickets: 'Ticket management', updates: 'Flight updates', codes: 'Tracking codes', users: 'Users', transactions: 'Transactions', support: 'Customer care', staff: 'Staff', settings: 'Payment settings' };
const ROLE_LABELS = { user: 'Customer', support: 'Customer care', admin: 'Admin', super_admin: 'Super admin' };
let toastTimer;
let staff = null;
const state = { tickets: [], users: [], transactions: [], conversations: [], openConversation: null };

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin', ...options,
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = {};
  try { data = await response.json(); } catch {}
  if (response.status === 401 && !path.startsWith('/api/admin/login') && !path.startsWith('/api/admin/setup')) { lockAdmin(); }
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}
function escapeHTML(value = '') { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function dateLabel(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
function shortName(name = '') { const parts = String(name).trim().split(/\s+/).filter(Boolean); return parts.length > 1 ? `${parts[0]} ${parts.at(-1)[0]}.` : name || 'Passenger'; }
function statusTone(status) { if (['Delayed', 'pending'].includes(status)) return 'warn'; if (['Cancelled', 'failed', 'refunded'].includes(status)) return 'bad'; if (['Completed', 'Arrived', 'successful'].includes(status)) return 'good'; return ''; }
function naira(kobo) { return `₦${(Number(kobo || 0) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function isManager() { return ['admin', 'super_admin'].includes(staff?.role); }
function toast(message) { const el = document.getElementById('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600); }
const formData = (form) => Object.fromEntries(new FormData(form).entries());

// ---------- sign-in & setup ----------
function showAdmin(user) {
  staff = user;
  document.getElementById('loginView').hidden = true;
  document.getElementById('adminApp').hidden = false;
  document.getElementById('adminAvatar').textContent = (user.name || user.email || 'A').trim().charAt(0).toUpperCase();
  document.getElementById('staffName').textContent = user.name;
  document.getElementById('staffRole').textContent = ROLE_LABELS[user.role] || user.role;
  document.querySelectorAll('[data-manager-only]').forEach((el) => { el.hidden = !isManager(); });
  document.querySelector('#staffRoleSelect option[value="admin"]').hidden = user.role !== 'super_admin';
  navigateSection(location.hash.slice(1));
  refreshAll();
}
function lockAdmin() {
  staff = null;
  document.getElementById('adminApp').hidden = true;
  document.getElementById('loginView').hidden = false;
  showSetupIfNeeded();
}
async function showSetupIfNeeded() {
  let needsSetup = false;
  try { needsSetup = (await api('/api/admin/setup-status')).needsSetup; } catch {}
  document.getElementById('setupPanel').hidden = !needsSetup;
  document.getElementById('signinPanel').hidden = needsSetup;
}
document.getElementById('adminLoginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById('loginError');
  error.textContent = '';
  if (!form.reportValidity()) return;
  try { const { user } = await api('/api/admin/login', { method: 'POST', body: formData(form) }); form.reset(); showAdmin(user); }
  catch (err) { error.textContent = err.message; }
});
document.getElementById('adminSetupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById('setupError');
  error.textContent = '';
  if (!form.reportValidity()) return;
  const data = formData(form);
  if (data.password !== data.confirm) { error.textContent = 'Passwords do not match.'; return; }
  try {
    const { user } = await api('/api/admin/setup', { method: 'POST', body: data });
    form.reset();
    showAdmin(user);
    toast('Admin account created.');
  } catch (err) { error.textContent = err.message; showSetupIfNeeded(); }
});
document.getElementById('logoutButton').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch {}
  lockAdmin();
  toast('You have logged out.');
});

// ---------- data loading ----------
async function refreshAll() {
  try {
    const [t, u, x, s] = await Promise.all([api('/api/admin/tickets'), api('/api/admin/users'), api('/api/admin/transactions'), api('/api/admin/support')]);
    state.tickets = t.tickets; state.users = u.users; state.transactions = x.transactions; state.conversations = s.conversations;
    renderAll();
  } catch (err) { if (staff) toast(err.message); }
}
async function refreshSupport() {
  const { conversations } = await api('/api/admin/support');
  state.conversations = conversations;
  renderSupportList();
}
function renderAll() {
  renderOverview(state.tickets);
  renderTicketPage(state.tickets);
  renderUpdates(state.tickets);
  renderCodes(state.tickets);
  renderUsers();
  renderTransactions();
  renderSupportList();
  renderStaff();
}

// ---------- tickets ----------
function getHistory(ticket) { return Array.isArray(ticket.history) ? ticket.history : []; }
function allActivity(tickets) {
  return tickets.flatMap((ticket) => getHistory(ticket).map((entry) => ({ ...entry, code: ticket.code, flight: ticket.flightNumber, ticketId: ticket.id, passenger: ticket.passenger }))).sort((a, b) => new Date(b.at) - new Date(a.at));
}
function renderStatusOptions(selected = '') { return STATUSES.map((status) => `<option value="${escapeHTML(status)}" ${selected === status ? 'selected' : ''}>${escapeHTML(status)}</option>`).join(''); }
function renderTable(items, withControls = false) {
  if (!items.length) return '<div class="empty-table">No flight records found.</div>';
  const body = items.map((ticket) => `<tr><td><strong>${escapeHTML(ticket.id)}</strong></td><td><span class="code-text">${escapeHTML(ticket.code)}</span></td><td><strong>${escapeHTML(shortName(ticket.passenger))}</strong><small>${escapeHTML(ticket.ownerEmail || '')}</small></td><td>${escapeHTML(ticket.airline || '—')}<small>${escapeHTML(ticket.flightNumber || '')}</small></td><td>${escapeHTML(ticket.departureAirport || '—')}</td><td>${escapeHTML(ticket.destinationAirport || '—')}</td><td><span class="status-pill ${statusTone(ticket.status)}">${escapeHTML(ticket.status || 'Ticket Created')}</span>${ticket.paymentStatus === 'unpaid' ? '<small>Awaiting payment</small>' : ticket.paymentStatus === 'paid' ? '<small>Paid</small>' : ''}</td><td>${escapeHTML(dateLabel(ticket.createdAt))}</td><td>${withControls ? `<div class="update-controls"><select aria-label="New status for ${escapeHTML(ticket.code)}" data-status-for="${escapeHTML(ticket.id)}">${renderStatusOptions(ticket.status)}</select><button type="button" data-save-status="${escapeHTML(ticket.id)}">Save</button></div>` : `<a class="row-action" href="/flighttrack?code=${encodeURIComponent(ticket.code || '')}" target="_blank" rel="noopener">Track ↗</a>`}</td></tr>`).join('');
  return `<table class="data-table"><thead><tr><th>TICKET ID</th><th>TRACKING CODE</th><th>PASSENGER / OWNER</th><th>AIRLINE / FLIGHT</th><th>DEPARTURE</th><th>DESTINATION</th><th>STATUS</th><th>CREATED</th><th>${withControls ? 'UPDATE STATUS' : 'PUBLIC VIEW'}</th></tr></thead><tbody>${body}</tbody></table>`;
}
function renderOverview(tickets) {
  const count = (status) => tickets.filter((ticket) => ticket.status === status).length;
  document.getElementById('statTotal').textContent = tickets.length;
  document.getElementById('statActive').textContent = tickets.filter((ticket) => !['Completed', 'Cancelled'].includes(ticket.status)).length;
  document.getElementById('statCompleted').textContent = count('Completed');
  document.getElementById('statAttention').textContent = count('Delayed') + count('Cancelled');
  document.getElementById('donutTotal').textContent = tickets.length;
  const counts = STATUSES.map((status) => ({ status, count: count(status) })).filter((item) => item.count);
  let offset = 0;
  const total = tickets.length || 1;
  const gradient = counts.length ? counts.map((item) => { const start = offset; offset += item.count / total * 100; return `${CHART_COLORS[STATUSES.indexOf(item.status)]} ${start}% ${offset}%`; }).join(', ') : '#e8edf1 0 100%';
  document.getElementById('statusDonut').style.background = `conic-gradient(${gradient})`;
  document.getElementById('statusLegend').innerHTML = counts.length ? counts.map((item) => `<div class="legend-item"><i style="background:${CHART_COLORS[STATUSES.indexOf(item.status)]}"></i><span>${escapeHTML(item.status)}</span><strong>${item.count}</strong></div>`).join('') : '<div class="empty-content">No status data yet.</div>';
  const activity = allActivity(tickets).slice(0, 5);
  document.getElementById('recentActivity').innerHTML = activity.length ? activity.map((item) => `<div class="activity-item"><span class="activity-dot">↗</span><div class="activity-copy"><strong>${escapeHTML(item.status || 'Tracking update')} · ${escapeHTML(item.code)}</strong><small>${escapeHTML(item.announcement || '')} · ${escapeHTML(dateLabel(item.at))}</small></div></div>`).join('') : '<div class="empty-content">Tracking updates will appear here.</div>';
  document.getElementById('recentTickets').innerHTML = renderTable(tickets.slice(0, 5));
}
function renderTicketPage(tickets) {
  const query = document.getElementById('ticketSearch').value.trim().toLowerCase();
  const status = document.getElementById('statusFilter').value;
  const filtered = tickets.filter((ticket) => {
    const fields = [ticket.code, ticket.passenger, ticket.flightNumber, ticket.airline, ticket.id, ticket.ownerEmail].join(' ').toLowerCase();
    return (!query || fields.includes(query)) && (!status || ticket.status === status);
  });
  document.getElementById('ticketTable').innerHTML = renderTable(filtered, true);
}
function renderUpdates(tickets) {
  const activity = allActivity(tickets);
  document.getElementById('updatesList').innerHTML = activity.length ? activity.map((item) => `<article class="update-record"><time class="update-time">${escapeHTML(dateLabel(item.at))}</time><div class="update-details"><strong>${escapeHTML(item.status || 'Tracking update')} · ${escapeHTML(item.flight || item.code)}</strong><p>${escapeHTML(item.announcement || 'Status updated')} · ${escapeHTML(item.source || 'Record history')} · ${escapeHTML(shortName(item.passenger))}</p></div><a class="update-code" href="/flighttrack?code=${encodeURIComponent(item.code || '')}" target="_blank" rel="noopener">${escapeHTML(item.code)} ↗</a></article>`).join('') : '<div class="empty-content">No tracking history has been recorded yet.</div>';
}
function renderCodes(tickets) {
  document.getElementById('codesTable').innerHTML = tickets.length ? `<table class="data-table"><thead><tr><th>TRACKING CODE</th><th>TICKET ID</th><th>FLIGHT</th><th>ROUTE</th><th>STATUS</th><th>HISTORY ENTRIES</th><th>LINK</th></tr></thead><tbody>${tickets.map((ticket) => `<tr><td><span class="code-text">${escapeHTML(ticket.code)}</span></td><td>${escapeHTML(ticket.id)}</td><td>${escapeHTML(ticket.airline || '—')}<small>${escapeHTML(ticket.flightNumber || '')}</small></td><td>${escapeHTML(ticket.departureAirport || '—')} → ${escapeHTML(ticket.destinationAirport || '—')}</td><td><span class="status-pill ${statusTone(ticket.status)}">${escapeHTML(ticket.status || 'Ticket Created')}</span></td><td>${getHistory(ticket).length}</td><td><button type="button" class="row-action" data-copy-link="${escapeHTML(ticket.code)}">Copy tracking link</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty-table">No tracking codes have been created yet.</div>';
}
async function saveStatus(id) {
  const status = document.querySelector(`[data-status-for="${CSS.escape(id)}"]`)?.value;
  if (!STATUSES.includes(status)) return;
  try {
    await api(`/api/admin/tickets/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: { status } });
    toast(`Tracking status saved: ${status}.`);
    const { tickets } = await api('/api/admin/tickets');
    state.tickets = tickets;
    renderOverview(tickets); renderTicketPage(tickets); renderUpdates(tickets); renderCodes(tickets);
  } catch (err) { toast(err.message); }
}

// ---------- users ----------
function roleOptions(user) {
  const roles = staff.role === 'super_admin' ? ['user', 'support', 'admin', 'super_admin'] : ['user', 'support'];
  if (!roles.includes(user.role)) return null;
  return roles.map((r) => `<option value="${r}" ${r === user.role ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`).join('');
}
function userActions(user) {
  if (!isManager() || user.id === staff.id) return '<span class="muted">—</span>';
  if (user.role === 'super_admin' && staff.role !== 'super_admin') return '<span class="muted">—</span>';
  const options = roleOptions(user);
  return `<div class="update-controls">${options ? `<select aria-label="Role for ${escapeHTML(user.email)}" data-role-for="${escapeHTML(user.id)}">${options}</select><button type="button" data-save-role="${escapeHTML(user.id)}">Save</button>` : ''}<button type="button" class="${user.suspended ? '' : 'danger'}" data-toggle-suspend="${escapeHTML(user.id)}">${user.suspended ? 'Reactivate' : 'Suspend'}</button></div>`;
}
function renderUsers() {
  const query = document.getElementById('userSearch').value.trim().toLowerCase();
  const role = document.getElementById('roleFilter').value;
  const list = state.users.filter((u) => (!role || u.role === role) && (!query || [u.name, u.email, u.id].join(' ').toLowerCase().includes(query)));
  document.getElementById('usersTable').innerHTML = list.length ? `<table class="data-table"><thead><tr><th>NAME</th><th>ROLE</th><th>STATUS</th><th>TICKETS</th><th>TRANSACTIONS</th><th>TOTAL PAID</th><th>JOINED</th><th>ACTIONS</th></tr></thead><tbody>${list.map((u) => `<tr><td><strong>${escapeHTML(u.name)}</strong><small>${escapeHTML(u.email)} · ${escapeHTML(u.id)}</small></td><td><span class="status-pill">${escapeHTML(ROLE_LABELS[u.role] || u.role)}</span></td><td><span class="status-pill ${u.suspended ? 'bad' : 'good'}">${u.suspended ? 'Suspended' : 'Active'}</span></td><td>${u.tickets}</td><td>${u.transactions}</td><td>${naira(u.paidTotal)}</td><td>${escapeHTML(dateLabel(u.createdAt))}</td><td>${userActions(u)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-table">No users found.</div>';
}
async function updateUser(id, changes, message) {
  try {
    await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: changes });
    state.users = (await api('/api/admin/users')).users;
    renderUsers(); renderStaff();
    toast(message);
  } catch (err) { toast(err.message); }
}

// ---------- transactions ----------
function renderTransactions() {
  const all = state.transactions;
  document.getElementById('txnTotal').textContent = naira(all.filter((t) => t.status === 'successful').reduce((sum, t) => sum + t.amount, 0));
  document.getElementById('txnSuccess').textContent = all.filter((t) => t.status === 'successful').length;
  document.getElementById('txnPending').textContent = all.filter((t) => t.status === 'pending').length;
  document.getElementById('txnFailed').textContent = all.filter((t) => ['failed', 'refunded'].includes(t.status)).length;
  const query = document.getElementById('txnSearch').value.trim().toLowerCase();
  const status = document.getElementById('txnFilter').value;
  const list = all.filter((t) => (!status || t.status === status) && (!query || [t.reference, t.userName, t.userEmail, t.ticketCode, t.id].join(' ').toLowerCase().includes(query)));
  document.getElementById('txnTable').innerHTML = list.length ? `<table class="data-table"><thead><tr><th>REFERENCE</th><th>CUSTOMER</th><th>TICKET</th><th>AMOUNT</th><th>STATUS</th><th>PROVIDER</th><th>DATE</th><th></th></tr></thead><tbody>${list.map((t) => `<tr><td><span class="code-text">${escapeHTML(t.reference)}</span><small>${escapeHTML(t.description || '')}</small></td><td><strong>${escapeHTML(t.userName || 'Unknown')}</strong><small>${escapeHTML(t.userEmail || '')}</small></td><td>${t.ticketCode ? `<span class="code-text">${escapeHTML(t.ticketCode)}</span>` : '—'}</td><td><strong>${naira(t.amount)}</strong></td><td><span class="status-pill ${statusTone(t.status)}">${escapeHTML(t.status)}</span></td><td>${escapeHTML(t.provider)}${t.providerTransactionId ? `<small>ID ${escapeHTML(t.providerTransactionId)}</small>` : ''}</td><td>${escapeHTML(dateLabel(t.createdAt))}</td><td>${t.status === 'pending' ? `<button type="button" class="row-action" data-recheck="${escapeHTML(t.reference)}">Re-check</button>` : ''}</td></tr>`).join('')}</tbody></table>` : `<div class="empty-table">${all.length ? 'No transactions match your search.' : 'No transactions yet. Payments made through Flutterwave will appear here.'}</div>`;
}

// ---------- customer care ----------
function renderSupportList() {
  const filter = document.getElementById('supportFilter').value;
  const awaiting = state.conversations.filter((c) => c.awaitingReply).length;
  const badge = document.getElementById('supportBadge');
  badge.hidden = !awaiting;
  badge.textContent = awaiting;
  const list = state.conversations.filter((c) => !filter || (filter === 'awaiting' ? c.awaitingReply : c.status === filter));
  document.getElementById('supportList').innerHTML = list.length ? list.map((c) => `<button type="button" class="support-item ${state.openConversation?.id === c.id ? 'active' : ''}" data-open-conversation="${escapeHTML(c.id)}"><span class="support-item-top"><strong>${escapeHTML(c.subject)}</strong>${c.awaitingReply ? '<em>Needs reply</em>' : ''}</span><small>${escapeHTML(c.name)} · ${escapeHTML(c.email)}</small><small>${escapeHTML(c.id)} · ${escapeHTML(dateLabel(c.updatedAt))}${c.assignedName ? ` · ${escapeHTML(c.assignedName)}` : ''}</small></button>`).join('') : '<div class="empty-content">No conversations here.</div>';
}
function renderConversation(conv) {
  state.openConversation = conv;
  const view = document.getElementById('supportView');
  if (!conv) { view.innerHTML = '<div class="empty-content">Select a conversation to read and reply.</div>'; return; }
  view.innerHTML = `<div class="support-view-head"><div><h2>${escapeHTML(conv.subject)}</h2><p>${escapeHTML(conv.name)} · <a href="mailto:${escapeHTML(conv.email)}">${escapeHTML(conv.email)}</a> · ${escapeHTML(conv.id)}${conv.userId ? ` · Account ${escapeHTML(conv.userId)}` : ' · Guest'}</p></div><div class="support-view-actions"><button type="button" class="secondary-button" data-assign-me="${escapeHTML(conv.id)}">Assign to me</button><button type="button" class="secondary-button" data-toggle-conversation="${escapeHTML(conv.id)}" data-next="${conv.status === 'closed' ? 'open' : 'closed'}">${conv.status === 'closed' ? 'Reopen' : 'Mark resolved'}</button></div></div>
  <div class="support-messages">${conv.messages.map((m) => `<div class="support-msg ${m.sender === 'staff' ? 'from-staff' : 'from-customer'}"><small>${m.sender === 'staff' ? `${escapeHTML(m.staffName || 'Staff')} · Customer care` : escapeHTML(conv.name)} · ${escapeHTML(dateLabel(m.createdAt))}</small><p>${escapeHTML(m.body)}</p></div>`).join('')}</div>
  <form class="support-reply" id="staffReplyForm"><label class="sr-only" for="staffReply">Reply</label><textarea id="staffReply" name="message" rows="3" placeholder="Write a reply to the customer…" required></textarea><button class="primary-button" type="submit">Send reply</button></form>`;
  renderSupportList();
}
async function openConversation(id) {
  try { renderConversation((await api(`/api/admin/support/${encodeURIComponent(id)}`)).conversation); }
  catch (err) { toast(err.message); }
}
document.getElementById('supportView').addEventListener('submit', async (event) => {
  if (event.target.id !== 'staffReplyForm') return;
  event.preventDefault();
  const message = event.target.elements.message.value.trim();
  if (!message || !state.openConversation) return;
  try {
    const { conversation } = await api(`/api/admin/support/${encodeURIComponent(state.openConversation.id)}/messages`, { method: 'POST', body: { message } });
    renderConversation(conversation);
    await refreshSupport();
    toast('Reply sent.');
  } catch (err) { toast(err.message); }
});
async function patchConversation(id, body, message) {
  try {
    const { conversation } = await api(`/api/admin/support/${encodeURIComponent(id)}`, { method: 'PATCH', body });
    renderConversation(conversation);
    await refreshSupport();
    toast(message);
  } catch (err) { toast(err.message); }
}

// ---------- staff ----------
function renderStaff() {
  const team = state.users.filter((u) => ['support', 'admin', 'super_admin'].includes(u.role));
  document.getElementById('staffTable').innerHTML = team.length ? `<table class="data-table"><thead><tr><th>NAME</th><th>ROLE</th><th>STATUS</th><th>ADDED</th><th>ACTIONS</th></tr></thead><tbody>${team.map((u) => `<tr><td><strong>${escapeHTML(u.name)}</strong><small>${escapeHTML(u.email)}</small></td><td><span class="status-pill">${escapeHTML(ROLE_LABELS[u.role])}</span></td><td><span class="status-pill ${u.suspended ? 'bad' : 'good'}">${u.suspended ? 'Suspended' : 'Active'}</span></td><td>${escapeHTML(dateLabel(u.createdAt))}</td><td>${userActions(u)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-table">No staff yet.</div>';
}
document.getElementById('staffForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById('staffError');
  error.textContent = '';
  if (!form.reportValidity()) return;
  try {
    const { user } = await api('/api/admin/staff', { method: 'POST', body: formData(form) });
    form.reset();
    state.users = (await api('/api/admin/users')).users;
    renderUsers(); renderStaff();
    toast(`${user.name} can now sign in at /admin.`);
  } catch (err) { error.textContent = err.message; }
});

// ---------- payment settings ----------
async function loadSettings() {
  try {
    const s = await api('/api/admin/settings');
    document.getElementById('priceForm').elements.ticketPriceNaira.value = (s.ticketPrice / 100).toString();
    const webhookUrl = `${location.origin}/api/payments/webhook`;
    const row = (ok, label, detail) => `<div class="pay-row"><span class="status-pill ${ok ? 'good' : 'warn'}">${ok ? 'Ready' : 'Missing'}</span><div><strong>${label}</strong><small>${detail}</small></div></div>`;
    document.getElementById('paymentStatus').innerHTML =
      row(s.flutterwaveConnected, 'Secret key', s.flutterwaveConnected ? 'Flutterwave is connected.' : 'Add the Flutterwave secret key in the Netlify project settings.') +
      row(s.webhookConfigured, 'Webhook secret hash', s.webhookConfigured ? 'Payment notifications are verified.' : 'Optional but recommended. Set a secret hash in Flutterwave and Netlify.') +
      row(s.ticketPrice > 0, 'Ticket price', s.ticketPrice > 0 ? `Customers pay ${naira(s.ticketPrice)} per ticket.` : 'Price is 0, so tickets are free.') +
      `<div class="pay-row"><span class="status-pill">URL</span><div><strong>Webhook URL for Flutterwave</strong><small><span class="code-text">${escapeHTML(webhookUrl)}</span> <button type="button" class="row-action" data-copy-text="${escapeHTML(webhookUrl)}">Copy</button></small></div></div>`;
  } catch (err) { toast(err.message); }
}
document.getElementById('priceForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById('priceError');
  error.textContent = '';
  if (!form.reportValidity()) return;
  try {
    await api('/api/admin/settings', { method: 'PUT', body: { ticketPriceNaira: Number(form.elements.ticketPriceNaira.value) } });
    toast('Ticket price saved.');
    loadSettings();
  } catch (err) { error.textContent = err.message; }
});

// ---------- navigation & events ----------
function navigateSection(section) {
  let valid = SECTIONS[section] ? section : 'overview';
  if (['staff', 'settings'].includes(valid) && !isManager()) valid = 'overview';
  if (staff && valid === 'settings') loadSettings();
  document.querySelectorAll('.admin-section').forEach((element) => { element.hidden = element.id !== `${valid}Section`; });
  document.querySelectorAll('.side-link[data-section]').forEach((link) => link.classList.toggle('active', link.dataset.section === valid));
  document.getElementById('breadcrumbPage').textContent = SECTIONS[valid];
  document.getElementById('sidebar').classList.remove('open');
  history.replaceState({}, '', `#${valid}`);
  if (staff && valid === 'support') refreshSupport().catch(() => {});
}
document.getElementById('ticketSearch').addEventListener('input', () => renderTicketPage(state.tickets));
document.getElementById('statusFilter').insertAdjacentHTML('beforeend', renderStatusOptions());
document.getElementById('statusFilter').addEventListener('change', () => renderTicketPage(state.tickets));
document.getElementById('userSearch').addEventListener('input', renderUsers);
document.getElementById('roleFilter').addEventListener('change', renderUsers);
document.getElementById('txnSearch').addEventListener('input', renderTransactions);
document.getElementById('txnFilter').addEventListener('change', renderTransactions);
document.getElementById('supportFilter').addEventListener('change', renderSupportList);
document.getElementById('sidebarToggle').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));
document.addEventListener('click', async (event) => {
  const sectionLink = event.target.closest('[data-section], [data-section-link]');
  if (sectionLink) { event.preventDefault(); navigateSection(sectionLink.dataset.section || sectionLink.dataset.sectionLink); return; }
  const t = (sel) => event.target.closest(sel);
  if (t('[data-save-status]')) saveStatus(t('[data-save-status]').dataset.saveStatus);
  if (t('[data-save-role]')) {
    const id = t('[data-save-role]').dataset.saveRole;
    const role = document.querySelector(`[data-role-for="${CSS.escape(id)}"]`)?.value;
    updateUser(id, { role }, `Role updated to ${ROLE_LABELS[role]}.`);
  }
  if (t('[data-toggle-suspend]')) {
    const id = t('[data-toggle-suspend]').dataset.toggleSuspend;
    const user = state.users.find((u) => u.id === id);
    if (user && (user.suspended || confirm(`Suspend ${user.name}? They will be signed out and unable to log in.`))) updateUser(id, { suspended: !user.suspended }, user.suspended ? 'Account reactivated.' : 'Account suspended.');
  }
  if (t('[data-open-conversation]')) openConversation(t('[data-open-conversation]').dataset.openConversation);
  if (t('[data-assign-me]')) patchConversation(t('[data-assign-me]').dataset.assignMe, { assignToMe: true }, 'Conversation assigned to you.');
  if (t('[data-toggle-conversation]')) { const b = t('[data-toggle-conversation]'); patchConversation(b.dataset.toggleConversation, { status: b.dataset.next }, b.dataset.next === 'closed' ? 'Marked as resolved.' : 'Conversation reopened.'); }
  if (t('[data-recheck]')) {
    try {
      const { transaction } = await api(`/api/admin/transactions/${encodeURIComponent(t('[data-recheck]').dataset.recheck)}/verify`, { method: 'POST' });
      toast(`Transaction is ${transaction.status}.`);
      await refreshAll();
    } catch (err) { toast(err.message); }
  }
  if (t('[data-copy-text]')) { try { await navigator.clipboard.writeText(t('[data-copy-text]').dataset.copyText); toast('Copied.'); } catch { toast(t('[data-copy-text]').dataset.copyText); } }
  const copyButton = t('[data-copy-link]');
  if (copyButton) {
    const url = `${location.origin}/flighttrack?code=${encodeURIComponent(copyButton.dataset.copyLink)}`;
    try { await navigator.clipboard.writeText(url); toast('Tracking link copied.'); }
    catch { toast(url); }
  }
});
window.addEventListener('hashchange', () => { if (staff) navigateSection(location.hash.slice(1)); });

(async () => {
  try { const { user } = await api('/api/admin/me'); showAdmin(user); }
  catch { lockAdmin(); }
})();
