const summary = document.querySelector('#summary');
const rows = [...document.querySelectorAll('[data-service]')];
const checked = document.querySelector('#checked time');
const labels = { operational: 'Operational', unavailable: 'Unavailable', unknown: 'Status unconfirmed' };
const staleAfter = 20 * 60_000;

async function refresh() {
  try {
    const response = await fetch('./status.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Snapshot unavailable');
    const snapshot = await response.json();
    const age = Date.now() - Date.parse(snapshot.checkedAt);
    if (!Number.isFinite(age)) throw new Error('Invalid check date');
    checked.dateTime = snapshot.checkedAt;
    checked.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(snapshot.checkedAt));
    const states = rows.map(row => {
      const value = snapshot.services?.[row.dataset.service];
      const state = Object.hasOwn(labels, value) ? value : 'unknown';
      row.dataset.status = age > staleAfter ? 'unknown' : state;
      row.textContent = age > staleAfter ? 'Last check expired' : labels[state];
      return state;
    });
    if (age > staleAfter) summary.textContent = 'Latest check is overdue';
    else if (states.includes('unavailable')) summary.textContent = 'Service interruption';
    else if (states.includes('unknown')) summary.textContent = 'Some checks are unconfirmed';
    else summary.textContent = 'All services operational';
  } catch {
    summary.textContent = 'Latest check could not be loaded';
    for (const row of rows) {
      row.dataset.status = 'unknown';
      row.textContent = 'Status unavailable';
    }
  }
}

void refresh();
setInterval(refresh, 60_000);
