const pageNames = ['home', 'login', 'dashboard', 'create', 'tickets', 'about', 'contact'];
const statuses = ['Ticket Created', 'Ticket Confirmed', 'Check-in Open', 'Boarding', 'Departed', 'In Transit', 'Delayed', 'Landed', 'Arrived', 'Completed', 'Cancelled'];
let toastTimer;
let me = null;
let myTickets = [];
let siteConfig = { ticketPrice: 0, currency: 'NGN', paymentsEnabled: false };
const naira = (kobo) => `₦${(Number(kobo || 0) / 100).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { status: response.status });
  return data;
}
function currentUser() { return me; }
function escapeHTML(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}
function setPage(name) {
  const page = pageNames.includes(name) ? name : 'home';
  document.querySelectorAll('[data-page]').forEach((section) => section.classList.toggle('active', section.dataset.page === page));
  document.querySelectorAll('[data-nav]').forEach((link) => link.classList.toggle('is-current', link.dataset.nav === page));
  document.getElementById('mainNav').classList.remove('is-open');
  document.getElementById('menuToggle').setAttribute('aria-expanded', 'false');
  document.getElementById('menuToggle').textContent = '☰';
  window.scrollTo(0, 0);
  if (page === 'dashboard') renderDashboard();
  if (page === 'tickets') renderAllTickets();
  if (page === 'contact') renderContact();
}
function navigate(name) {
  if (name === 'track') { location.href = '/flighttrack'; return; }
  history.pushState({}, '', `/#${name}`);
  setPage(name);
}
function syncAuthNavigation() {
  const signedIn = !!me;
  document.querySelectorAll('.guest-link').forEach((element) => { element.hidden = signedIn; });
  document.querySelectorAll('.auth-link').forEach((element) => { element.hidden = !signedIn; });
  document.getElementById('logoutButton').hidden = !signedIn;
}
function formObject(form) { return Object.fromEntries(new FormData(form).entries()); }
function formattedDate(date, time) {
  if (!date) return 'Date not set';
  const value = new Date(`${date}T${time || '00:00'}`);
  return Number.isNaN(value.getTime()) ? `${date} ${time || ''}` : value.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
function statusClass(status) {
  if (status === 'Delayed') return 'delayed';
  if (status === 'Cancelled') return 'cancelled';
  if (status === 'Ticket Created') return 'neutral';
  return '';
}
function ticketRow(ticket) {
  const statusOptions = statuses.map((status) => `<option value="${escapeHTML(status)}" ${status === ticket.status ? 'selected' : ''}>${escapeHTML(status)}</option>`).join('');
  return `<article class="ticket-row"><div class="ticket-route"><div class="route-stop"><strong>${escapeHTML(ticket.departureAirport)}</strong><small>${escapeHTML(formattedDate(ticket.departureDate, ticket.departureTime))}</small></div><span class="route-line"></span><div class="route-stop"><strong>${escapeHTML(ticket.destinationAirport)}</strong><small>${escapeHTML(formattedDate(ticket.arrivalDate, ticket.arrivalTime))}</small></div></div><div class="ticket-meta"><strong>${escapeHTML(ticket.airline)} · ${escapeHTML(ticket.flightNumber)}</strong><small>${escapeHTML(ticket.code)}</small></div>${ticket.paymentStatus === 'unpaid' ? '<span class="status-pill delayed">Awaiting payment</span>' : `<span class="status-pill ${statusClass(ticket.status)}">${escapeHTML(ticket.status)}</span>`}<div class="row-actions">${ticket.paymentStatus === 'unpaid' ? `<button type="button" class="pay-button" data-pay-ticket="${escapeHTML(ticket.id)}">Pay now</button>` : `<a href="/flighttrack?code=${encodeURIComponent(ticket.code)}">Track</a>`}<button type="button" data-copy-code="${escapeHTML(ticket.code)}">Copy code</button><label class="sr-only" for="status-${escapeHTML(ticket.id)}">Update status for ${escapeHTML(ticket.code)}</label><select id="status-${escapeHTML(ticket.id)}" data-status-select>${statusOptions}</select><button type="button" data-update-status="${escapeHTML(ticket.id)}">Update status</button></div></article>`;
}
function emptyState() {
  return `<div class="empty-state"><div class="empty-icon">✈</div><h3>No flight records yet</h3><p>Create your first record to get a unique shareable tracking code.</p><a class="button button-primary" href="#create">Create a ticket <span>→</span></a></div>`;
}
const loadingState = '<div class="empty-state"><p>Loading…</p></div>';
async function loadTickets() {
  const data = await api('/api/tickets');
  myTickets = data.tickets;
  return myTickets;
}
async function renderDashboard() {
  if (!me) { navigate('login'); return; }
  document.getElementById('welcomeHeading').textContent = `Welcome back, ${me.name.split(' ')[0]}.`;
  const list = document.getElementById('dashboardTickets');
  list.innerHTML = loadingState;
  try {
    const own = await loadTickets();
    document.getElementById('statTotal').textContent = own.length;
    document.getElementById('statActive').textContent = own.filter((ticket) => !['Completed', 'Cancelled'].includes(ticket.status)).length;
    document.getElementById('statCompleted').textContent = own.filter((ticket) => ticket.status === 'Completed').length;
    document.getElementById('statDelayed').textContent = own.filter((ticket) => ticket.status === 'Delayed').length;
    list.innerHTML = own.length ? own.slice(0, 4).map(ticketRow).join('') : emptyState();
  } catch (error) { handleApiError(error, list); }
}
async function renderAllTickets() {
  if (!me) { navigate('login'); return; }
  const list = document.getElementById('allTickets');
  list.innerHTML = loadingState;
  try {
    const own = await loadTickets();
    list.innerHTML = own.length ? own.map(ticketRow).join('') : emptyState();
  } catch (error) { handleApiError(error, list); }
}
function handleApiError(error, target) {
  if (error.status === 401) { me = null; syncAuthNavigation(); navigate('login'); showToast('Your session ended. Please log in again.'); return; }
  if (target) target.innerHTML = `<div class="empty-state"><p>${escapeHTML(error.message)}</p></div>`;
  else showToast(error.message);
}

// ---------- customer care ----------
function threadHTML(conversation) {
  const messages = conversation.messages.map((m) => `<div class="support-msg ${m.sender === 'staff' ? 'from-staff' : 'from-customer'}"><small>${m.sender === 'staff' ? `${escapeHTML(m.staffName || 'Customer care')} · Customer care` : 'You'} · ${escapeHTML(new Date(m.createdAt).toLocaleString())}</small><p>${escapeHTML(m.body)}</p></div>`).join('');
  return `<article class="support-thread" data-thread="${escapeHTML(conversation.id)}"><div class="support-thread-head"><div><strong>${escapeHTML(conversation.subject)}</strong><small>Reference ${escapeHTML(conversation.id)}</small></div><span class="status-pill ${conversation.status === 'closed' ? 'neutral' : ''}">${conversation.status === 'closed' ? 'Closed' : 'Open'}</span></div><div class="support-messages">${messages}</div><form class="support-reply" data-reply-form="${escapeHTML(conversation.id)}"><label class="sr-only" for="reply-${escapeHTML(conversation.id)}">Reply</label><textarea id="reply-${escapeHTML(conversation.id)}" name="message" rows="2" placeholder="Write a reply…" required></textarea><button class="button button-primary" type="submit">Send</button></form></article>`;
}
let guestLookup = null; // { id, email } for guests checking a request
async function renderContact() {
  document.getElementById('supportGuestFields').hidden = !!me;
  document.querySelectorAll('#supportGuestFields input').forEach((input) => { input.required = !me; });
  document.getElementById('supportLookup').hidden = !!me;
  const mine = document.getElementById('mySupport');
  mine.hidden = !me;
  if (!me) return;
  const list = document.getElementById('mySupportList');
  list.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { conversations } = await api('/api/support/mine');
    if (!conversations.length) { list.innerHTML = '<p class="muted">You have no support requests yet.</p>'; return; }
    const threads = await Promise.all(conversations.map((c) => api(`/api/support/${encodeURIComponent(c.id)}`).then((d) => d.conversation)));
    list.innerHTML = threads.map(threadHTML).join('');
  } catch (error) { handleApiError(error, list); }
}
document.getElementById('supportForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById('supportError');
  error.textContent = '';
  if (!form.reportValidity()) return;
  const data = formObject(form);
  try {
    const { reference } = await api('/api/support', { method: 'POST', body: data });
    form.reset();
    if (me) { showToast(`Message sent. Reference ${reference}.`); renderContact(); }
    else {
      document.getElementById('supportSent').innerHTML = `<div class="notice"><span>✓</span><p>Message sent. Your reference is <strong>${escapeHTML(reference)}</strong>. Use it with your email below to check for replies from customer care.</p></div>`;
      const lookup = document.getElementById('supportLookupForm');
      lookup.elements.reference.value = reference;
      lookup.elements.email.value = data.email;
    }
  } catch (err) { error.textContent = err.message; }
});
document.getElementById('supportLookupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const target = document.getElementById('supportLookupResult');
  if (!form.reportValidity()) return;
  const { reference, email } = formObject(form);
  try {
    const { conversation } = await api(`/api/support/${encodeURIComponent(reference.trim().toUpperCase())}?email=${encodeURIComponent(email.trim())}`);
    guestLookup = { id: conversation.id, email: email.trim() };
    target.innerHTML = threadHTML(conversation);
  } catch (err) { target.innerHTML = `<p class="form-error">${escapeHTML(err.message)}</p>`; }
});
document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-reply-form]');
  if (!form) return;
  event.preventDefault();
  const id = form.dataset.replyForm;
  const message = form.elements.message.value.trim();
  if (!message) return;
  try {
    const { conversation } = await api(`/api/support/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { message, email: guestLookup?.id === id ? guestLookup.email : undefined } });
    form.closest('.support-thread').outerHTML = threadHTML(conversation);
    showToast('Reply sent.');
  } catch (err) { showToast(err.message); }
});

// ---------- accounts ----------
function showAuthPanel(mode) {
  document.getElementById('loginPanel').hidden = mode !== 'login';
  document.getElementById('registerPanel').hidden = mode !== 'register';
}
document.getElementById('showRegister').addEventListener('click', (event) => { event.preventDefault(); showAuthPanel('register'); });
document.getElementById('showLogin').addEventListener('click', (event) => { event.preventDefault(); showAuthPanel('login'); });

document.getElementById('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById('loginError');
  error.textContent = '';
  if (!form.reportValidity()) return;
  try {
    const { user } = await api('/api/auth/login', { method: 'POST', body: formObject(form) });
    me = user;
    syncAuthNavigation();
    form.reset();
    navigate('dashboard');
    showToast('You are logged in.');
  } catch (err) { error.textContent = err.message; }
});
document.getElementById('registerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById('registerError');
  error.textContent = '';
  if (!form.reportValidity()) return;
  try {
    const { user } = await api('/api/auth/register', { method: 'POST', body: formObject(form) });
    me = user;
    syncAuthNavigation();
    form.reset();
    showAuthPanel('login');
    navigate('dashboard');
    showToast('Account created. You are logged in.');
  } catch (err) { error.textContent = err.message; }
});
document.getElementById('logoutButton').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  me = null;
  syncAuthNavigation();
  navigate('home');
  showToast('You have logged out.');
});

// ---------- tickets ----------
document.getElementById('ticketForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById('ticketError');
  error.textContent = '';
  if (!me) { navigate('login'); showToast('Please log in before creating or managing tickets.'); return; }
  if (!form.reportValidity()) return;
  const data = formObject(form);
  if (new Date(`${data.arrivalDate}T${data.arrivalTime}`) < new Date(`${data.departureDate}T${data.departureTime}`)) {
    error.textContent = 'Arrival must be after departure. Check the dates and times.';
    return;
  }
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const { ticket, needsPayment } = await api('/api/tickets', { method: 'POST', body: data });
    form.reset();
    if (needsPayment) { showToast('Record saved. Redirecting to secure payment…'); await startPayment(ticket.id); return; }
    showToast(`Record created. Tracking code: ${ticket.code}`);
    location.href = `/flighttrack?code=${encodeURIComponent(ticket.code)}`;
  } catch (err) {
    if (err.status === 401) handleApiError(err);
    else error.textContent = err.message;
  } finally { button.disabled = false; }
});

function submitTracking(form) {
  const code = new FormData(form).get('code');
  location.href = `/flighttrack?code=${encodeURIComponent(String(code || '').trim())}`;
}
document.getElementById('heroTrackForm').addEventListener('submit', (event) => { event.preventDefault(); submitTracking(event.currentTarget); });

// ---------- payments ----------
async function startPayment(ticketId) {
  try {
    const { link } = await api(`/api/tickets/${encodeURIComponent(ticketId)}/pay`, { method: 'POST' });
    location.href = link;
  } catch (err) {
    showToast(err.message);
    navigate('tickets');
  }
}
async function handlePaymentReturn() {
  const params = new URLSearchParams(location.search);
  const ref = params.get('tx_ref');
  if (!ref) return false;
  history.replaceState({}, '', '/#tickets');
  if (!me) { showToast('Log in to confirm your payment.'); return false; }
  showToast('Confirming your payment…');
  try {
    const { status, ticketCode } = await api(`/api/payments/verify?tx_ref=${encodeURIComponent(ref)}`);
    if (status === 'successful' && ticketCode) { showToast('Payment confirmed. Your tracking code is active.'); location.href = `/flighttrack?code=${encodeURIComponent(ticketCode)}`; return true; }
    if (status === 'pending') showToast('Your payment is still processing. Check back in a moment.');
    else showToast('Payment was not completed. You can try again with “Pay now”.');
  } catch (err) { showToast(err.message); }
  return false;
}
function renderPriceNotice() {
  const notice = document.getElementById('priceNotice');
  if (!notice) return;
  notice.hidden = !siteConfig.paymentsEnabled;
  notice.innerHTML = `<span>₦</span><p>Creating a flight record costs <strong>${naira(siteConfig.ticketPrice)}</strong>. After saving, you'll pay securely with Flutterwave (card, bank transfer or USSD). Your tracking code becomes active once payment is confirmed.</p>`;
  const submit = document.querySelector('#ticketForm [type="submit"]');
  if (submit) submit.innerHTML = siteConfig.paymentsEnabled ? `Continue to payment · ${naira(siteConfig.ticketPrice)} <span>→</span>` : 'Create ticket <span>→</span>';
}

document.addEventListener('click', async (event) => {
  const payButton = event.target.closest('[data-pay-ticket]');
  if (payButton) { payButton.disabled = true; payButton.textContent = 'Redirecting…'; startPayment(payButton.dataset.payTicket); return; }
  const updateStatus = event.target.closest('[data-update-status]');
  const copyCode = event.target.closest('[data-copy-code]');
  if (updateStatus) {
    const selectedStatus = updateStatus.closest('.ticket-row')?.querySelector('[data-status-select]')?.value;
    try {
      await api(`/api/tickets/${encodeURIComponent(updateStatus.dataset.updateStatus)}/status`, { method: 'PATCH', body: { status: selectedStatus } });
      if (document.getElementById('dashboardPage').classList.contains('active')) renderDashboard();
      if (document.getElementById('ticketsPage').classList.contains('active')) renderAllTickets();
      showToast(`Ticket status updated to ${selectedStatus}.`);
    } catch (err) { handleApiError(err); }
  }
  if (copyCode) {
    try { await navigator.clipboard.writeText(copyCode.dataset.copyCode); showToast('Tracking code copied.'); }
    catch { showToast(`Tracking code: ${copyCode.dataset.copyCode}`); }
  }
});

document.getElementById('menuToggle').addEventListener('click', (event) => {
  const menu = document.getElementById('mainNav');
  const open = menu.classList.toggle('is-open');
  event.currentTarget.setAttribute('aria-expanded', String(open));
  event.currentTarget.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  event.currentTarget.textContent = open ? '×' : '☰';
});
function syncPageFromLocation() {
  const destination = location.hash.slice(1).split('?')[0] || 'home';
  if (destination === 'track') { location.href = '/flighttrack'; return; }
  if (destination === 'create' && !me) { setPage('login'); showToast('Log in to create a flight record.'); return; }
  if (['dashboard', 'tickets'].includes(destination) && !me) { setPage('login'); showToast('Log in to view your flight records.'); return; }
  setPage(destination);
}
window.addEventListener('hashchange', syncPageFromLocation);
window.addEventListener('popstate', syncPageFromLocation);

document.getElementById('year').textContent = new Date().getFullYear();
(async () => {
  const [meResult, configResult] = await Promise.allSettled([api('/api/auth/me'), api('/api/config')]);
  me = meResult.status === 'fulfilled' ? meResult.value.user : null;
  if (configResult.status === 'fulfilled') siteConfig = configResult.value;
  renderPriceNotice();
  syncAuthNavigation();
  if (await handlePaymentReturn()) return;
  syncPageFromLocation();
})();
