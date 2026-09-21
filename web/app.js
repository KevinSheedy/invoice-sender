'use strict';

// Gig Invoices – phone app. One screen: build an invoice, leave it in Gmail as a draft.
// Everything else lives in the Apps Script backend (apps-script/Code.gs).

const CONFIG_KEY = 'gigInvoices.connection';
const CACHE_KEY = 'gigInvoices.config';
const VENUES_KEY = 'gigInvoices.venues';
const DETAILS_KEY = 'gigInvoices.details';
const TEST_KEY = 'gigInvoices.testMode';
const OTHER = '__other';

let connection = readLocal(CONFIG_KEY) || { url: '', key: '' };
// Your name and bank details, kept on this phone and sent with each invoice.
let details = readLocal(DETAILS_KEY) || { name: '', email: '', phone: '', accountName: '', iban: '' };
// Test mode swaps the client's email domain for a harmless one, so nothing reaches a real client.
let testMode = readLocal(TEST_KEY) === true;
const state = {
  config: readLocal(CACHE_KEY),
  starting: true,
  error: '',
  clientId: '',
  custom: { name: '', email: '' },
  gigs: [],   // filled in at the bottom, once newGig() can read state
  method: '',   // empty means "whatever this client normally gets"
  done: null,
};

const $ = sel => document.querySelector(sel);

function newGig() {
  // feeAuto marks a fee that came from the client's default, so switching client can replace it.
  return { date: today(), venue: '', fee: defaultFee(), feeAuto: true };
}

function defaultFee() {
  const client = currentClient();
  return client && client.defaultFee !== null ? String(client.defaultFee) : '';
}

// ---------------------------------------------------------------------------
// Storage and API

function readLocal(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function writeLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // Storage can be unavailable (private browsing); the app still works without it.
  }
}

function isConnected() {
  return Boolean(connection.url && connection.key);
}

function hasDetails() {
  return Boolean(details.name.trim());
}

const REQUEST_TIMEOUT_MS = 30000;

async function api(action, data) {
  if (!isConnected()) throw new Error('Connect the app to Google in Settings first');
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(connection.url, {
      method: 'POST',
      // text/plain keeps this a "simple" request, which Apps Script needs (it can't answer CORS preflights).
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key: connection.key, action, data }),
      signal: stop.signal,
    });
  } catch (err) {
    throw new Error(err && err.name === 'AbortError'
      ? 'Google took too long to answer – try again'
      : 'Couldn\'t reach Google – check your signal and try again');
  } finally {
    clearTimeout(timer);
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new Error('Google sent back something unexpected – check the web app URL in Settings');
  }
  if (!body.ok) throw new Error(body.error || 'Something went wrong');
  return body.result;
}

async function loadConfig() {
  if (!isConnected()) {
    state.starting = false;
    render();
    return;
  }
  state.starting = true;
  render();
  try {
    state.config = await api('config');
    state.error = '';
    writeLocal(CACHE_KEY, state.config);
    if (!state.clientId) selectClient(state.config.clients[0] ? state.config.clients[0].id : OTHER);
  } catch (err) {
    state.error = err.message;
  }
  state.starting = false;
  render();
}

// ---------------------------------------------------------------------------
// Helpers

function h(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function today() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function currency() {
  return (state.config && state.config.currency) || 'EUR';
}

function money(v) {
  try {
    return new Intl.NumberFormat('en-IE', { style: 'currency', currency: currency() }).format(Number(v) || 0);
  } catch (err) {
    return (Number(v) || 0).toFixed(2) + ' ' + currency();
  }
}

function clients() {
  return (state.config && state.config.clients) || [];
}

function currentClient() {
  return clients().find(c => c.id === state.clientId) || null;
}

function method() {
  const client = currentClient();
  return state.method || (client ? client.method : 'pdf');
}

function total() {
  return state.gigs.reduce((sum, g) => sum + (Number(String(g.fee).replace(/[€£$,\s]/g, '')) || 0), 0);
}

function selectClient(id) {
  state.clientId = id;
  state.method = '';
  const fee = defaultFee();
  state.gigs.forEach(g => {
    if (g.feeAuto || !String(g.fee).trim()) {
      g.fee = fee;
      g.feeAuto = true;
    }
  });
}

// Mirrors what the script does to the address in test mode, so the app promises the truth.
function shownEmail(email) {
  return testMode ? String(email || '').replace(/@.*$/, '@example.org') : (email || '');
}

function invoiceData() {
  const gigs = state.gigs.map(g => ({ date: g.date, venue: g.venue, fee: g.fee }));
  const data = { me: details, gigs, method: method(), test: testMode };
  if (state.clientId === OTHER) {
    data.clientName = state.custom.name;
    data.clientEmail = state.custom.email;
  } else {
    data.clientId = state.clientId;
  }
  return data;
}

function recentVenues() {
  return readLocal(VENUES_KEY) || [];
}

function rememberVenues() {
  const venues = state.gigs.map(g => g.venue.trim()).filter(Boolean).concat(recentVenues());
  writeLocal(VENUES_KEY, venues.filter((v, i, all) => all.indexOf(v) === i).slice(0, 20));
}

function resetForm() {
  state.gigs = [newGig()];
  state.method = '';
  state.done = null;
  selectClient(state.clientId);
}

// ---------------------------------------------------------------------------
// Views

function render() {
  const settings = location.hash === '#/settings';
  const starting = !settings && isConnected() && state.starting;
  const failed = !settings && isConnected() && !state.starting && state.error;
  $('#title').textContent = settings ? 'Settings'
    : starting ? 'Gig Invoices'
      : failed ? 'Can\'t reach Google'
        : state.done ? 'Draft ready' : 'New invoice';
  $('#back').hidden = !settings;
  $('#refresh').hidden = settings;
  $('#settings-link').hidden = starting;

  const view = $('#view');
  view.innerHTML = settings ? settingsHtml()
    : starting ? splashHtml()
      : failed ? errorHtml()
        : state.done ? doneHtml() : formHtml();
  if (settings) bindSettings(view);
  else if (starting) return;
  else if (failed) bindError(view);
  else if (state.done) bindDone(view);
  else bindForm(view);
}

function splashHtml() {
  return `
    <div class="splash">
      <img src="icons/icon.svg" alt="" width="84" height="84">
      <div class="spinner" aria-label="Loading"></div>
      <p class="hint">Connecting to Google…</p>
    </div>`;
}

function errorHtml() {
  return `
    <div class="splash">
      <img src="icons/icon.svg" alt="" width="84" height="84" style="opacity:0.35">
      <div class="error" style="margin:0">${h(state.error)}</div>
      ${state.config ? '<p class="hint">You can still fill in an invoice, but drafting it needs Google.</p>' : ''}
    </div>
    <div class="stack">
      <button class="btn primary" id="retry" type="button">Try again</button>
      ${state.config ? '<button class="btn" id="carry-on" type="button">Fill it in anyway</button>' : ''}
      <a class="btn" href="#/settings">Settings</a>
    </div>`;
}

function bindError(root) {
  root.querySelector('#retry').addEventListener('click', e => busy(e.currentTarget, 'Trying…', loadConfig));
  const carryOn = root.querySelector('#carry-on');
  if (carryOn) {
    carryOn.addEventListener('click', () => {
      state.error = '';
      render();
    });
  }
}

function formHtml() {
  if (!isConnected() || !hasDetails()) {
    return `
      <div class="card pad">
        <p style="margin-top:0"><strong>Welcome!</strong> This app drafts gig invoices in your own Gmail.</p>
        <p style="margin-bottom:0">${isConnected()
          ? 'Add your name and bank details – they go on every invoice, and stay on this phone.'
          : 'Connect it to your Apps Script web app, then add the details that go on your invoices.'}</p>
      </div>
      <div class="stack"><a class="btn primary big" href="#/settings">${isConnected() ? 'Add your details' : 'Get started'}</a></div>`;
  }
  if (!state.config) return splashHtml();

  const custom = state.clientId === OTHER;
  const client = currentClient();
  const venues = recentVenues();

  const gigs = state.gigs.map((g, i) => `
    <div class="card">
      ${state.gigs.length > 1 ? `
        <div class="gig-head">
          <span>Gig ${i + 1}</span>
          <button type="button" class="remove" data-remove="${i}">Remove</button>
        </div>` : ''}
      <div class="row2">
        <label class="field"><span>Date</span>
          <input type="date" value="${h(g.date)}" data-field="date" data-index="${i}">
        </label>
        <label class="field"><span>Fee (${h(currency())})</span>
          <input value="${h(g.fee)}" inputmode="decimal" placeholder="0.00" data-field="fee" data-index="${i}">
        </label>
      </div>
      <label class="field"><span>Venue</span>
        <input value="${h(g.venue)}" list="venues" autocomplete="off" autocapitalize="words"
          enterkeyhint="done" data-field="venue" data-index="${i}">
      </label>
    </div>`).join('');

  return `
    ${state.error ? `<div class="error">${h(state.error)}</div>` : ''}
    ${testMode ? '<div class="test-banner">Test mode – emails go to @example.org, not the client</div>' : ''}
    <div class="card">
      <label class="field"><span>Client</span>
        <select id="client">
          ${clients().map(c => `<option value="${h(c.id)}" ${c.id === state.clientId ? 'selected' : ''}>${h(c.name)}</option>`).join('')}
          <option value="${OTHER}" ${custom ? 'selected' : ''}>Someone else…</option>
        </select>
      </label>
      ${custom ? `
        <label class="field"><span>Name</span>
          <input value="${h(state.custom.name)}" id="custom-name" autocapitalize="words" enterkeyhint="next">
        </label>
        <label class="field"><span>Email</span>
          <input value="${h(state.custom.email)}" id="custom-email" type="email" inputmode="email"
            autocapitalize="off" autocorrect="off" enterkeyhint="done">
        </label>` : ''}
    </div>

    <div class="section-title">Gigs <button type="button" class="link" id="add-gig">＋ Add gig</button></div>
    ${gigs}
    <datalist id="venues">${venues.map(v => `<option value="${h(v)}">`).join('')}</datalist>

    <div class="section-title">Send as</div>
    <div class="segmented">
      <button type="button" data-method="body" aria-pressed="${method() === 'body'}">In the email</button>
      <button type="button" data-method="pdf" aria-pressed="${method() === 'pdf'}">PDF attachment</button>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="total"><span>Total</span><span class="amount" id="total">${money(total())}</span></div>
    </div>

    <div class="stack">
      <button class="btn" id="preview" type="button">Preview</button>
      <button class="btn primary big" id="create" type="button">Create Gmail draft</button>
    </div>
    <p class="hint">Goes to ${custom
      ? h(shownEmail(state.custom.email) || 'the address above')
      : h(client ? client.name + ' <' + shownEmail(client.email) + '>' : '')}.
      It'll be waiting in your Gmail drafts for you to check and send.</p>`;
}

function doneHtml() {
  const d = state.done;
  return `
    ${d.test ? '<div class="test-banner">Test mode – this went to a test address</div>' : ''}
    <div class="card pad">
      <p style="margin-top:0"><strong>Draft ready in Gmail.</strong></p>
      <p style="margin-bottom:0">To ${h(d.to)}<br>“${h(d.subject)}”<br>
        ${d.method === 'pdf' ? 'Invoice attached as a PDF' : 'Invoice in the email itself'} · ${money(d.total)}</p>
    </div>
    <div class="stack">
      <a class="btn primary big" href="googlegmail://">Open Gmail to send it</a>
      <button class="btn" id="again" type="button">New invoice</button>
    </div>
    ${d.messageId ? `<p class="hint" style="text-align:center">
      <a href="googlegmail:///cv=${h(d.messageId)}">Try opening the draft itself</a> –
      an old Gmail link that may do nothing.</p>` : ''}`;
}

// Shows which published version is running, so you can tell whether a refresh worked.
function buildLabel() {
  const build = window.BUILD || {};
  if (!build.at) return 'Running a local build';
  const when = new Date(build.at);
  const stamp = isNaN(when) ? build.at : new Intl.DateTimeFormat('en-IE',
    { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(when);
  return `Updated ${stamp} · ${build.commit || '?'}`;
}

function settingsHtml() {
  const field = (name, label, attrs = '') =>
    `<label class="field"><span>${label}</span><input name="${name}" value="${h(details[name])}" ${attrs}></label>`;
  return `
    <form id="details-form" novalidate>
      <div class="section-title">Your details</div>
      <div class="card">
        ${field('name', 'Name', 'autocapitalize="words" enterkeyhint="next"')}
        ${field('email', 'Email', 'type="email" inputmode="email" autocapitalize="off" autocorrect="off"')}
        ${field('phone', 'Phone', 'type="tel"')}
      </div>
      <div class="card">
        ${field('accountName', 'Account name', 'autocapitalize="words"')}
        ${field('iban', 'IBAN', 'autocapitalize="characters" autocorrect="off" spellcheck="false"')}
      </div>
      <div class="stack"><button class="btn ${hasDetails() ? '' : 'primary'}" type="submit">Save my details</button></div>
      <p class="hint">These go at the top of the invoice and in its payment box. They're stored on this
        phone only – never in Google or on GitHub. Leave a line blank to keep it off the invoice.</p>
    </form>

    <form id="connect-form" novalidate>
      <div class="section-title">Connection</div>
      <div class="card">
        <label class="field"><span>Web app URL</span>
          <input name="url" type="url" value="${h(connection.url)}" placeholder="https://script.google.com/macros/s/…/exec"
            autocapitalize="off" autocorrect="off" spellcheck="false">
        </label>
        <label class="field"><span>API key</span>
          <input name="key" value="${h(connection.key)}" autocapitalize="off" autocorrect="off"
            autocomplete="off" spellcheck="false">
        </label>
      </div>
      <div class="stack">
        <button class="btn ${isConnected() ? '' : 'primary'}" type="submit">${isConnected() ? 'Update connection' : 'Connect'}</button>
      </div>
    </form>
    <p class="hint">Both come from the Apps Script setup steps in the README. They're stored only on this phone.</p>
    <p class="hint">Your clients and the email wording live in <code>CONFIG</code> at the top of
      <code>Code.gs</code>. Change them there and deploy.</p>
    <div class="section-title">Test mode</div>
    <div class="segmented">
      <button type="button" data-test="off" aria-pressed="${!testMode}">Off – real clients</button>
      <button type="button" data-test="on" aria-pressed="${testMode}">On – test address</button>
    </div>
    <p class="hint">With test mode on, an invoice to angel@anuna.ie is drafted to angel@example.org
      instead, and the subject starts with [TEST]. Nothing can reach a client by accident.</p>

    <div class="section-title">App</div>
    <div class="stack" style="margin-top:0">
      <button class="btn" id="refresh-app" type="button">Check for updates</button>
    </div>
    <p class="hint" style="text-align:center">${h(buildLabel())}</p>`;
}

// ---------------------------------------------------------------------------
// Behaviour

function bindForm(root) {
  if (!state.config) return;

  root.querySelector('#client').addEventListener('change', e => {
    selectClient(e.target.value);
    render();
  });
  const name = root.querySelector('#custom-name');
  if (name) name.addEventListener('input', e => { state.custom.name = e.target.value; });
  const email = root.querySelector('#custom-email');
  if (email) email.addEventListener('input', e => { state.custom.email = e.target.value; });

  root.querySelectorAll('[data-field]').forEach(input => {
    input.addEventListener('input', e => {
      const gig = state.gigs[Number(e.target.dataset.index)];
      gig[e.target.dataset.field] = e.target.value;
      if (e.target.dataset.field === 'fee') {
        gig.feeAuto = false;   // you've set this one yourself now
        root.querySelector('#total').textContent = money(total());
      }
    });
  });
  root.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.gigs.splice(Number(btn.dataset.remove), 1);
      render();
    });
  });
  root.querySelector('#add-gig').addEventListener('click', () => {
    state.gigs.push(newGig());
    render();
  });
  root.querySelectorAll('[data-method]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.method = btn.dataset.method;
      render();
    });
  });

  root.querySelector('#preview').addEventListener('click', async e => {
    const res = await busy(e.currentTarget, 'Preparing…', () => api('preview', invoiceData()));
    if (!res) return;
    if (typeof res.html !== 'string' || !res.html) {
      // Shouldn't happen; showing what did come back beats rendering "undefined" in the sheet.
      const got = typeof res === 'string' ? res : JSON.stringify(res);
      toast('No preview came back from Google. It replied: ' + String(got).slice(0, 80), true);
      return;
    }
    openSheet(res.html);
  });
  root.querySelector('#create').addEventListener('click', async e => {
    const res = await busy(e.currentTarget, 'Creating…', () => api('createDraft', invoiceData()));
    if (!res) return;
    rememberVenues();
    state.done = res;
    render();
    toast('Draft ready in Gmail');
  });
}

function bindDone(root) {
  root.querySelector('#again').addEventListener('click', () => {
    resetForm();
    render();
  });
}

function bindSettings(root) {
  const detailsForm = root.querySelector('#details-form');
  detailsForm.addEventListener('submit', e => {
    e.preventDefault();
    const entered = Object.fromEntries(new FormData(detailsForm));
    if (!String(entered.name).trim()) {
      toast('Your name goes at the top of the invoice, so it\'s needed', true);
      return;
    }
    details = entered;
    writeLocal(DETAILS_KEY, details);
    toast('Details saved');
    if (isConnected()) location.hash = '#/';
    else render();
  });

  root.querySelectorAll('[data-test]').forEach(btn => {
    btn.addEventListener('click', () => {
      testMode = btn.dataset.test === 'on';
      writeLocal(TEST_KEY, testMode);
      toast(testMode ? 'Test mode on – emails go to @example.org' : 'Test mode off – emails go to real clients');
      render();
    });
  });

  root.querySelector('#refresh-app').addEventListener('click', e => {
    busy(e.currentTarget, 'Updating…', refreshApp);
  });

  const form = root.querySelector('#connect-form');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const next = { url: form.url.value.trim(), key: form.key.value.trim() };
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(next.url) && !/^http:\/\/localhost[:/]/.test(next.url)) {
      toast('The URL should start with https://script.google.com/ and end with /exec', true);
      return;
    }
    const previous = connection;
    connection = next;
    const config = await busy(form.querySelector('[type=submit]'), 'Connecting…', () => api('config'));
    if (!config) {
      connection = previous;
      return;
    }
    writeLocal(CONFIG_KEY, connection);
    state.config = config;
    state.error = '';
    writeLocal(CACHE_KEY, config);
    selectClient(config.clients[0] ? config.clients[0].id : OTHER);
    toast('Connected');
    if (hasDetails()) location.hash = '#/';
    else render();
  });
}

// Fetches the app's files again, past both caches, then reloads. Your saved settings
// (connection, details, venues) live in localStorage and are untouched.
async function refreshApp() {
  const files = ['./', 'index.html', 'app.js', 'build.js', 'styles.css', 'manifest.webmanifest'];
  try {
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    await Promise.all(files.map(f => fetch(f, { cache: 'reload' }).catch(() => {})));
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(r => r.update().catch(() => {})));
    }
  } catch (err) {
    // Whatever failed, reloading is still the best next step.
  }
  location.reload();
  return null;
}

// ---------------------------------------------------------------------------
// UI helpers

async function busy(button, label, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await fn();
  } catch (err) {
    toast(err.message, true);
    return null;
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

let toastTimer;
function toast(message, bad = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('bad', bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 6000 : 2500);
}

function openSheet(html) {
  $('#sheet-frame').srcdoc = '<!DOCTYPE html><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<div style="padding:16px;background:#fff;">' + html + '</div>';
  $('#sheet').hidden = false;
}

// ---------------------------------------------------------------------------
// Start up

$('#refresh').addEventListener('click', e => {
  e.currentTarget.disabled = true;
  e.currentTarget.classList.add('working');
  toast('Checking for updates…');
  refreshApp();
});
$('#sheet-close').addEventListener('click', () => { $('#sheet').hidden = true; });
window.addEventListener('hashchange', () => {
  render();
  window.scrollTo(0, 0);
});

if (state.config && clients().length) state.clientId = clients()[0].id;
state.gigs = [newGig()];
render();
loadConfig();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
