const statusProgress = { 'Ticket Created': 8, 'Ticket Confirmed': 18, 'Check-in Open': 28, Boarding: 38, Departed: 52, 'In Transit': 70, Delayed: 58, Landed: 88, Arrived: 96, Completed: 100, Cancelled: 8 };
let toastTimeout;

function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function displayDate(date, time) {
  if (!date) return 'Date not set';
  const value = new Date(`${date}T${time || '00:00'}`);
  return Number.isNaN(value.getTime()) ? `${date} ${time || ''}` : value.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
function maskedPassenger(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Passenger details private';
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)[0]}.` : `${parts[0][0]}.`;
}
function statusStyle(status) {
  if (status === 'Delayed') return 'delayed';
  if (status === 'Cancelled') return 'cancelled';
  if (status === 'Ticket Created') return 'neutral';
  return '';
}
function formatTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : date.toLocaleString();
}
function showMessage(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 2600);
}
async function renderTicket(rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  const target = document.getElementById('trackingResult');
  if (!code) {
    target.innerHTML = '';
    return;
  }
  target.innerHTML = '<p class="muted">Looking up tracking code…</p>';
  let ticket = null;
  try {
    const response = await fetch(`/api/track/${encodeURIComponent(code)}`);
    if (response.ok) ticket = (await response.json()).ticket;
    else if (response.status === 402) {
      target.innerHTML = `<div class="not-found"><div class="not-found-icon">₦</div><h2>This tracking code is awaiting payment.</h2><p>It becomes active as soon as the record owner's payment is confirmed.</p></div>`;
      return;
    }
    else if (response.status !== 404) throw new Error();
  } catch {
    target.innerHTML = `<div class="not-found"><div class="not-found-icon">!</div><h2>We couldn't reach the tracking service.</h2><p>Check your connection and try again.</p></div>`;
    return;
  }
  if (!ticket) {
    target.innerHTML = `<div class="not-found"><div class="not-found-icon">⌕</div><h2>We couldn't find a record with that tracking code.</h2><p>Check the code and try again. Codes are case-insensitive.</p></div>`;
    return;
  }
  const history = Array.isArray(ticket.history) ? [...ticket.history].reverse() : [];
  const status = ticket.status || 'Ticket Created';
  const progress = statusProgress[status] ?? 8;
  const caption = ['Delayed', 'Cancelled'].includes(status)
    ? 'Status shown from the record history · no live aircraft position available'
    : 'Illustrative status progress · no live aircraft position available';
  const link = `${location.origin}/flighttrack?code=${encodeURIComponent(ticket.code)}`;
  target.innerHTML = `<article class="tracking-card">
    <div class="tracking-top"><div><div class="eyebrow eyebrow-dark">PLATFORM-GENERATED RECORD · NOT AIRLINE-ISSUED</div><h2>${escapeHTML(ticket.airline || 'Airline')} <span class="muted">${escapeHTML(ticket.flightNumber || '')}</span></h2></div><div class="tracking-code">${escapeHTML(ticket.code)}<br><small class="muted">Ticket ID ${escapeHTML(ticket.id || '—')}</small></div></div>
    <div class="tracking-status"><div><small>CURRENT STATUS</small><strong>${escapeHTML(status)}</strong></div><span class="source-label">User-entered · not verified live data</span></div>
    <div class="tracking-route"><div class="route-visual" style="--route-progress:${progress}%" aria-label="Illustrative route progress, not a live aircraft position"><div class="route-node"><small>FROM</small><strong>${escapeHTML(ticket.departureAirport || '—')}</strong></div><div class="route-track"><div class="route-track-fill"></div><span class="route-track-plane" aria-hidden="true">✈</span></div><div class="route-node"><small>TO</small><strong>${escapeHTML(ticket.destinationAirport || '—')}</strong></div><div class="route-caption">${escapeHTML(caption)}</div></div>
      <div class="tracking-airport"><small>DEPARTURE</small><strong>${escapeHTML(ticket.departureAirport || '—')}</strong><span>${escapeHTML(displayDate(ticket.departureDate, ticket.departureTime))}</span></div><div class="tracking-airport right"><small>ESTIMATED ARRIVAL · RECORD TIME</small><strong>${escapeHTML(ticket.destinationAirport || '—')}</strong><span>${escapeHTML(displayDate(ticket.arrivalDate, ticket.arrivalTime))}</span></div></div>
    <div class="tracking-private"><strong>Passenger:</strong> ${escapeHTML(maskedPassenger(ticket.passenger))} &nbsp;·&nbsp; <strong>Class:</strong> ${escapeHTML(ticket.travelClass || 'Economy')}${ticket.seat ? ` &nbsp;·&nbsp; <strong>Seat:</strong> ${escapeHTML(ticket.seat)}` : ''}<br><strong>Last updated:</strong> ${escapeHTML(formatTimestamp(ticket.updatedAt))}</div>
    <div class="timeline-wrap"><h3 class="timeline-heading">Tracking updates</h3><div class="timeline">${history.length ? history.map((item, index) => `<div class="timeline-item ${index === 0 ? 'current' : ''}"><strong>${escapeHTML(item.status || 'Update')}</strong><p>${escapeHTML(item.announcement || '')} · ${escapeHTML(formatTimestamp(item.at))}</p></div>`).join('') : '<p class="muted">No updates yet.</p>'}</div></div>
    <div class="tracking-private">Share this record: <button class="text-button" type="button" data-copy-link="${escapeHTML(link)}">Copy tracking link</button><br>Only limited passenger information is shown publicly. Status updates are not airline-verified.</div>
  </article>`;
}
const form = document.getElementById('standaloneTrackForm');
const codeInput = document.getElementById('standaloneTrackingCode');
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const code = codeInput.value.trim();
  history.replaceState({}, '', `/flighttrack?code=${encodeURIComponent(code)}`);
  renderTicket(code);
});
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy-link]');
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.dataset.copyLink);
    showMessage('Tracking link copied.');
  } catch {
    showMessage(`Tracking link: ${button.dataset.copyLink}`);
  }
});
document.getElementById('year').textContent = new Date().getFullYear();
const initialCode = new URLSearchParams(location.search).get('code');
if (initialCode) {
  codeInput.value = initialCode;
  renderTicket(initialCode);
}
