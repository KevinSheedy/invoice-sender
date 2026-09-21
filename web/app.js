'use strict';

// Gig Invoices – phone app. One screen: build an invoice, leave it in Gmail as a draft.
// Everything else lives in the Apps Script backend (apps-script/Code.gs).

const CONFIG_KEY = 'gigInvoices.connection';
const CACHE_KEY = 'gigInvoices.config';
const VENUES_KEY = 'gigInvoices.venues';
const DETAILS_KEY = 'gigInvoices.details';
const OTHER = '__other';

let connection = readLocal(CONFIG_KEY) || { url: '', key: '' };
// Your name and bank details, kept on this phone and sent with each invoice.
let details = readLocal(DETAILS_KEY) || { name: '', email: '', phone: '', accountName: '', iban: '' };
const state = {
  config: readLocal(CACHE_KEY),
  error: '',
  clientId: '',
  custom: { name: '', email: '' },
  gigs: [newGig()],
  method: '',   // empty means "whatever this client normally gets"
  done: null,
};

const $ = sel => document.querySelector(sel);

function newGig() {
  return { date: today(), venue: '', fee: '' };
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

async function api(action, data) {
  if (!isConnected()) throw new Error('Connect the app to Google in Settings first');
  let res;
  try {
    res = await fetch(connection.url, {
      method: 'POST',
      // text/plain keeps this a "simple" request, which Apps Script needs (it can't answer CORS preflights).
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key: connection.key, action, data }),
    });
  } catch (err) {
    throw new Error('Couldn\'t reach Google – check your signal and try again');
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
  if (!isConnected()) return;
  try {
    state.config = await api('config');
    state.error = '';
    writeLocal(CACHE_KEY, state.config);
    if (!state.clientId) selectClient(state.config.clients[0] ? state.config.clients[0].id : OTHER);
  } catch (err) {
    state.error = err.message;
  }
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
  const client = currentClient();
  if (client && client.defaultFee !== null) {
    state.gigs.forEach(g => { if (!String(g.fee).trim()) g.fee = client.defaultFee; });
  }
}

function invoiceData() {
  const data = { me: details, gigs: state.gigs, method: method() };
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
  $('#title').textContent = settings ? 'Settings' : state.done ? 'Draft ready' : 'New invoice';
  $('#back').hidden = !settings;
  $('#settings-link').hidden = settings;

  const view = $('#view');
  view.innerHTML = settings ? settingsHtml() : state.done ? doneHtml() : formHtml();
  if (settings) bindSettings(view);
  else if (state.done) bindDone(view);
  else bindForm(view);
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
  if (!state.config) {
    return (state.error ? `<div class="error">${h(state.error)}</div>` : '') +
      (state.error
        ? '<div class="stack"><button class="btn" id="retry" type="button">Try again</button></div>'
        : '<p class="hint">Loading…</p>');
  }

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
    <p class="hint">Goes to ${custom ? h(state.custom.email || 'the address above') : h(client ? client.name + ' <' + client.email + '>' : '')}.
      It'll be waiting in your Gmail drafts for you to check and send.</p>`;
}

function doneHtml() {
  const d = state.done;
  return `
    <div class="card pad">
      <p style="margin-top:0"><strong>Draft ready in Gmail.</strong></p>
      <p style="margin-bottom:0">To ${h(d.to)}<br>“${h(d.subject)}”<br>
        ${d.method === 'pdf' ? 'Invoice attached as a PDF' : 'Invoice in the email itself'} · ${money(d.total)}</p>
    </div>
    <div class="stack">
      <a class="btn primary big" href="googlegmail://">Open Gmail to send it</a>
      <button class="btn" id="again" type="button">New invoice</button>
    </div>`;
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
      <code>Code.gs</code>. Change them there and deploy.</p>`;
}

// ---------------------------------------------------------------------------
// Behaviour

function bindForm(root) {
  const retry = root.querySelector('#retry');
  if (retry) retry.addEventListener('click', loadConfig);
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
      state.gigs[Number(e.target.dataset.index)][e.target.dataset.field] = e.target.value;
      if (e.target.dataset.field === 'fee') root.querySelector('#total').textContent = money(total());
    });
  });
  root.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.gigs.splice(Number(btn.dataset.remove), 1);
      render();
    });
  });
  root.querySelector('#add-gig').addEventListener('click', () => {
    const client = currentClient();
    const gig = newGig();
    if (client && client.defaultFee !== null) gig.fee = client.defaultFee;
    state.gigs.push(gig);
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
    if (res) openSheet(res.html);
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

$('#sheet-close').addEventListener('click', () => { $('#sheet').hidden = true; });
window.addEventListener('hashchange', () => {
  render();
  window.scrollTo(0, 0);
});

if (state.config && clients().length) selectClient(clients()[0].id);
render();
loadConfig();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
