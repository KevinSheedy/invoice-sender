'use strict';

// Gig Invoices – phone app. Talks to the Apps Script web app in apps-script/Code.gs.

const CONFIG_KEY = 'gigInvoices.config';
const CACHE_KEY = 'gigInvoices.data';
const SYNC_INTERVAL_MS = 30000;

const state = {
  clients: [],
  gigs: [],
  invoices: [],
  settings: null,
  loaded: false,
  syncing: false,
  lastSync: 0,
  error: '',
};
let config = readLocal(CONFIG_KEY) || { url: '', key: '' };
// Set when you type into a form, so a background refresh doesn't wipe what you've entered.
let formDirty = false;
// Gigs you've unticked on the New invoice screen, per client, kept while you pop out to add a gig.
const unticked = {};

const $ = sel => document.querySelector(sel);

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
    // Storage can be unavailable (private browsing); the app still works, just without the cache.
  }
}

function isConnected() {
  return Boolean(config.url && config.key);
}

async function api(action, data) {
  if (!isConnected()) throw new Error('Connect the app to Google in Settings first');
  let res;
  try {
    res = await fetch(config.url, {
      method: 'POST',
      // text/plain keeps this a "simple" request, which Apps Script needs (it can't answer CORS preflights).
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key: config.key, action, data }),
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

function applyData(data) {
  state.clients = data.clients || [];
  state.gigs = data.gigs || [];
  state.invoices = data.invoices || [];
  state.settings = data.settings || null;
  state.loaded = true;
}

function saveCache() {
  writeLocal(CACHE_KEY, {
    clients: state.clients, gigs: state.gigs, invoices: state.invoices, settings: state.settings,
  });
}

function upsert(list, item, key = 'id') {
  const i = list.findIndex(x => x[key] === item[key]);
  if (i === -1) list.push(item);
  else list[i] = item;
}

async function sync() {
  if (!isConnected() || state.syncing) return;
  state.syncing = true;
  showSyncState();
  try {
    applyData(await api('load'));
    saveCache();
    state.error = '';
    state.lastSync = Date.now();
  } catch (err) {
    state.error = err.message;
  } finally {
    state.syncing = false;
    showSyncState();
    render({ fromSync: true });
  }
}

// ---------------------------------------------------------------------------
// Formatting

function h(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function currency() {
  return (state.settings && state.settings.currency) || 'EUR';
}

function money(v, cur = currency()) {
  try {
    return new Intl.NumberFormat('en-IE', { style: 'currency', currency: cur }).format(Number(v) || 0);
  } catch (err) {
    return (Number(v) || 0).toFixed(2) + ' ' + cur;
  }
}

function fmtDate(iso, withDay = false) {
  const p = String(iso || '').split('-').map(Number);
  if (p.length !== 3 || !p[0]) return iso || '';
  const opts = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' };
  if (withDay) opts.weekday = 'short';
  return new Intl.DateTimeFormat('en-IE', opts).format(new Date(Date.UTC(p[0], p[1] - 1, p[2])));
}

function today() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function statusInfo(inv) {
  if (inv.status === 'paid') return { cls: 'paid', label: 'Paid' };
  if (inv.status === 'created') return { cls: 'created', label: 'Not emailed' };
  if (inv.status === 'draft') return { cls: 'draft', label: 'Draft in Gmail' };
  return { cls: 'sent', label: 'Awaiting payment' };
}

function pill(inv) {
  const s = statusInfo(inv);
  return `<span class="pill ${s.cls}">${s.label}</span>`;
}

function sendLabel() {
  return state.settings && state.settings.sendMode === 'send' ? 'Send invoice' : 'Create Gmail draft';
}

// ---------------------------------------------------------------------------
// Data helpers

function clientById(id) {
  return state.clients.find(c => c.id === id);
}

function byDateDesc(a, b) {
  return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
}

function sortedClients() {
  return state.clients.slice().sort((a, b) => a.name.localeCompare(b.name));
}

function unbilledGigs(clientId) {
  return state.gigs
    .filter(g => !g.invoiceNumber && (!clientId || g.clientId === clientId))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function sortedInvoices(list = state.invoices) {
  return list.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

function suggestedFee(clientId) {
  const last = state.gigs.filter(g => g.clientId === clientId).sort(byDateDesc)[0];
  if (last) return last.fee;
  const client = clientById(clientId);
  return client && client.defaultFee !== null ? client.defaultFee : '';
}

function recentClientId() {
  if (state.clients.length === 1) return state.clients[0].id;
  const last = state.gigs.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  return last ? last.clientId : '';
}

function knownVenues() {
  const seen = new Set();
  return state.gigs.slice().sort(byDateDesc).map(g => g.venue).filter(v => !seen.has(v) && seen.add(v));
}

// ---------------------------------------------------------------------------
// Routing

// Paths stay URL-encoded until split, so a ?return=/new?client=x parameter survives intact.
function parseRoute() {
  const raw = currentPath();
  const q = raw.indexOf('?');
  const path = q === -1 ? raw : raw.slice(0, q);
  return {
    parts: path.split('/').filter(Boolean).map(decodeURIComponent),
    query: new URLSearchParams(q === -1 ? '' : raw.slice(q + 1)),
  };
}

function currentPath() {
  return location.hash.slice(1) || '/';
}

function go(path, { replace = false } = {}) {
  const hash = '#' + path;
  if (replace) location.replace(hash);
  else location.hash = hash;
}

function withParam(path, key, value) {
  const [p, qs] = path.split('?');
  const params = new URLSearchParams(qs || '');
  params.set(key, value);
  return p + '?' + params.toString();
}

function resolveView() {
  const { parts, query } = parseRoute();
  if (parts[0] === 'settings') return settingsView();
  if (!isConnected()) return welcomeView();
  if (!state.loaded) return loadingView();
  switch (parts[0]) {
    case undefined: return homeView();
    case 'new': return newInvoiceView(query);
    case 'gig': return gigView(parts[1] || 'new', query);
    case 'invoice': return invoiceView(parts.slice(1).join('/'));
    case 'clients': return clientsView();
    case 'client': return clientView(parts[1] || 'new', query);
    default: return notFoundView();
  }
}

function render({ fromSync = false } = {}) {
  if (fromSync && formDirty) return;
  const view = resolveView();
  document.title = view.title === 'Gig Invoices' ? view.title : view.title + ' · Gig Invoices';
  $('#title').textContent = view.title;

  const back = $('#back');
  back.hidden = !view.back;
  if (view.back) back.href = '#' + view.back;

  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === view.tab));

  const banner = state.error && view.showError
    ? `<div class="error">${h(state.error)} <button class="link" id="retry">Try again</button></div>`
    : '';
  const root = $('#view');
  root.innerHTML = banner + view.html;
  formDirty = false;
  const retry = $('#retry');
  if (retry) retry.addEventListener('click', sync);
  if (view.bind) view.bind(root);
}

// ---------------------------------------------------------------------------
// Views

function welcomeView() {
  return {
    title: 'Gig Invoices',
    tab: 'home',
    html: `
      <div class="card pad">
        <p style="margin-top:0"><strong>Welcome!</strong> This app logs your gigs and emails invoices
        from your own Gmail.</p>
        <p style="margin-bottom:0">First, connect it to the Google Sheet you set up – you'll need the
        web app URL and API key from the setup steps.</p>
      </div>
      <div class="stack"><a class="btn primary big" href="#/settings">Connect</a></div>`,
  };
}

function loadingView() {
  return {
    title: 'Gig Invoices',
    tab: 'home',
    showError: true,
    html: state.error ? '' : '<p class="empty">Loading…</p>',
  };
}

function notFoundView() {
  return {
    title: 'Not found',
    back: '/',
    html: '<p class="empty">That page doesn\'t exist – it may have been removed.</p>',
  };
}

function homeView() {
  const unpaid = state.invoices.filter(i => i.status !== 'paid');
  const outstanding = unpaid.reduce((sum, i) => sum + i.total, 0);
  const waiting = sortedClients()
    .map(c => ({ client: c, gigs: unbilledGigs(c.id) }))
    .filter(x => x.gigs.length);
  const invoices = sortedInvoices();

  let html = `
    <div class="actions">
      <a class="btn big" href="#/gig/new">＋ Log a gig</a>
      <a class="btn big primary" href="#/new">New invoice</a>
    </div>`;

  if (!state.clients.length) {
    html += `
      <div class="card pad" style="margin-top:16px">
        <p style="margin:0 0 12px">Start by adding the people or venues who book you.</p>
        <a class="btn primary" href="#/client/new">Add your first client</a>
      </div>`;
  }

  if (unpaid.length) {
    html += `
      <div class="card pad summary" style="margin-top:16px">
        <div><div class="label">Awaiting payment</div><div class="big">${money(outstanding)}</div></div>
        <div class="label">${unpaid.length} invoice${unpaid.length === 1 ? '' : 's'}</div>
      </div>`;
  }

  if (waiting.length) {
    html += `<div class="section-title">Not invoiced yet</div><div class="card list">` +
      waiting.map(({ client, gigs }) => `
        <a href="#/new?client=${h(client.id)}">
          <div class="grow">
            <div class="primary">${h(client.name)}</div>
            <div class="secondary">${gigs.length} gig${gigs.length === 1 ? '' : 's'} · ${h([...new Set(gigs.map(g => g.venue))].join(', '))}</div>
          </div>
          <div class="amount">${money(gigs.reduce((s, g) => s + g.fee, 0))}</div>
          <span class="chevron"></span>
        </a>`).join('') + '</div>';
  }

  html += '<div class="section-title">Invoices</div>';
  html += invoices.length
    ? '<div class="card list">' + invoices.map(invoiceRow).join('') + '</div>'
    : '<div class="card"><p class="empty">No invoices yet.</p></div>';

  return { title: 'Gig Invoices', tab: 'home', showError: true, html };
}

function invoiceRow(inv) {
  return `
    <a href="#/invoice/${encodeURIComponent(inv.number)}">
      <div class="grow">
        <div class="primary">${h(inv.clientName)}</div>
        <div class="secondary">${h(inv.number)} · ${h(fmtDate(inv.issueDate))}</div>
      </div>
      <div class="amount">${money(inv.total, inv.currency)}<br>${pill(inv)}</div>
      <span class="chevron"></span>
    </a>`;
}

function gigView(id, query) {
  const gig = id === 'new' ? null : state.gigs.find(g => g.id === id);
  if (id !== 'new' && !gig) return notFoundView();
  const locked = Boolean(gig && gig.invoiceNumber);
  const back = query.get('return') || '/';
  const clientId = gig ? gig.clientId : query.get('client') || recentClientId();
  const values = gig || {
    clientId,
    date: today(),
    venue: '',
    description: (state.settings && state.settings.defaultDescription) || '',
    fee: clientId ? suggestedFee(clientId) : '',
  };

  const html = `
    ${locked ? `<div class="error">This gig is on invoice ${h(gig.invoiceNumber)}, so it can't be changed.</div>` : ''}
    <form id="gig-form" novalidate>
      <fieldset style="border:0;margin:0;padding:0" ${locked ? 'disabled' : ''}>
      <div class="card">
        <label class="field"><span>Client</span>
          <select name="clientId">
            <option value="" ${values.clientId ? '' : 'selected'} disabled>Choose a client…</option>
            ${sortedClients().map(c => `<option value="${h(c.id)}" ${c.id === values.clientId ? 'selected' : ''}>${h(c.name)}</option>`).join('')}
            <option value="__new">＋ New client…</option>
          </select>
        </label>
        <label class="field"><span>Date</span><input type="date" name="date" value="${h(values.date)}"></label>
        <label class="field"><span>Venue</span>
          <input name="venue" value="${h(values.venue)}" list="venues" autocomplete="off" autocapitalize="words" enterkeyhint="next">
        </label>
        <datalist id="venues">${knownVenues().map(v => `<option value="${h(v)}">`).join('')}</datalist>
        <label class="field"><span>Description (optional)</span>
          <input name="description" value="${h(values.description)}" autocapitalize="sentences" enterkeyhint="next">
        </label>
        <label class="field"><span>Fee (${h(currency())})</span>
          <input name="fee" value="${h(values.fee)}" inputmode="decimal" placeholder="0.00" enterkeyhint="done">
        </label>
      </div>
      </fieldset>
      ${locked ? '' : `
      <div class="stack">
        <button class="btn primary" type="submit">Save gig</button>
        ${gig ? '<button class="btn danger" type="button" id="delete-gig">Delete gig</button>' : ''}
      </div>`}
    </form>`;

  return {
    title: gig ? 'Edit gig' : 'Log a gig',
    back,
    tab: 'home',
    html,
    bind(root) {
      const form = root.querySelector('#gig-form');
      let feeTouched = Boolean(gig);
      form.fee.addEventListener('input', () => { feeTouched = true; });
      form.clientId.addEventListener('change', () => {
        if (form.clientId.value === '__new') {
          go('/client/new?return=' + encodeURIComponent(currentPath()));
          return;
        }
        if (!feeTouched) form.fee.value = suggestedFee(form.clientId.value);
      });
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(form));
        if (gig) data.id = gig.id;
        const saved = await busy(form.querySelector('[type=submit]'), 'Saving…', () => api('saveGig', data));
        if (!saved) return;
        upsert(state.gigs, saved);
        saveCache();
        toast('Gig saved');
        go(back.startsWith('/new') ? withParam(back, 'client', saved.clientId) : back);
      });
      const del = root.querySelector('#delete-gig');
      if (del) {
        del.addEventListener('click', async () => {
          if (!confirm('Delete this gig?')) return;
          const res = await busy(del, 'Deleting…', () => api('deleteGig', { id: gig.id }));
          if (!res) return;
          state.gigs = state.gigs.filter(g => g.id !== gig.id);
          saveCache();
          toast('Gig deleted');
          go(back);
        });
      }
    },
  };
}

function newInvoiceView(query) {
  const clients = sortedClients();
  const firstWaiting = clients.find(c => unbilledGigs(c.id).length);
  const clientId = query.get('client') || (firstWaiting ? firstWaiting.id : clients[0] && clients[0].id) || '';
  const client = clientById(clientId);
  const gigs = client ? unbilledGigs(client.id) : [];
  const skip = unticked[clientId] || (unticked[clientId] = new Set());
  const here = '/new?client=' + encodeURIComponent(clientId);
  const addGig = `/gig/new?client=${encodeURIComponent(clientId)}&return=${encodeURIComponent(here)}`;

  if (!clients.length) {
    return {
      title: 'New invoice',
      back: '/',
      tab: 'home',
      html: `<div class="card pad"><p style="margin:0 0 12px">Add a client first.</p>
        <a class="btn primary" href="#/client/new?return=${encodeURIComponent('/new')}">Add a client</a></div>`,
    };
  }

  const gigRows = gigs.length
    ? gigs.map(g => `
        <label class="check">
          <input type="checkbox" value="${h(g.id)}" ${skip.has(g.id) ? '' : 'checked'}>
          <div class="grow">
            <div class="primary">${h(g.venue)}</div>
            <div class="secondary">${h(fmtDate(g.date, true))}${g.description ? ' · ' + h(g.description) : ''}</div>
          </div>
          <div class="amount">${money(g.fee)}</div>
        </label>`).join('')
    : `<p class="empty">No gigs waiting to be invoiced for ${h(client ? client.name : 'this client')}.</p>`;

  const html = `
    <div class="card">
      <label class="field"><span>Client</span>
        <select id="client">
          ${clients.map(c => `<option value="${h(c.id)}" ${c.id === clientId ? 'selected' : ''}>${h(c.name)}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="section-title">Gigs to include <a href="#${h(addGig)}">＋ Add gig</a></div>
    <div class="card list" id="gigs">${gigRows}</div>
    <div class="card list" style="margin-top:12px">
      <div class="total-row"><span class="grow">Total</span><span class="amount" id="total"></span></div>
    </div>
    <div class="stack">
      <button class="btn" id="preview" type="button">Preview</button>
      <button class="btn primary big" id="create" type="button">${h(sendLabel())}</button>
    </div>
    ${client ? `<p class="hint">Goes to ${h(client.name)} &lt;${h(client.email)}&gt;.
      ${state.settings && state.settings.sendMode === 'send'
        ? 'It will be sent straight away.'
        : 'It will be waiting in your Gmail drafts for you to check and send.'}</p>` : ''}`;

  return {
    title: 'New invoice',
    back: '/',
    tab: 'home',
    html,
    bind(root) {
      const picked = () => gigs.filter(g => !skip.has(g.id));
      const update = () => {
        const chosen = picked();
        root.querySelector('#total').textContent = money(chosen.reduce((s, g) => s + g.fee, 0));
        root.querySelector('#preview').disabled = !chosen.length;
        root.querySelector('#create').disabled = !chosen.length;
      };
      update();

      root.querySelector('#client').addEventListener('change', e => {
        go('/new?client=' + encodeURIComponent(e.target.value), { replace: true });
      });
      root.querySelectorAll('#gigs input[type=checkbox]').forEach(box => {
        box.addEventListener('change', () => {
          if (box.checked) skip.delete(box.value);
          else skip.add(box.value);
          update();
        });
      });
      root.querySelector('#preview').addEventListener('click', async e => {
        const res = await busy(e.currentTarget, 'Preparing…', () =>
          api('previewInvoice', { clientId, gigIds: picked().map(g => g.id) }));
        if (res) openSheet('Invoice ' + res.number, res.html);
      });
      root.querySelector('#create').addEventListener('click', async e => {
        const chosen = picked();
        const total = money(chosen.reduce((s, g) => s + g.fee, 0));
        const sending = state.settings && state.settings.sendMode === 'send';
        const question = sending
          ? `Send a ${total} invoice to ${client.name} (${client.email}) now?`
          : `Create a ${total} invoice for ${client.name} and put it in your Gmail drafts?`;
        if (!confirm(question)) return;
        const res = await busy(e.currentTarget, sending ? 'Sending…' : 'Creating…', () =>
          api('createInvoice', { clientId, gigIds: chosen.map(g => g.id) }));
        if (!res) return;
        const inv = res.invoice;
        upsert(state.invoices, inv, 'number');
        state.gigs.forEach(g => { if (chosen.some(c => c.id === g.id)) g.invoiceNumber = inv.number; });
        delete unticked[clientId];
        saveCache();
        sync(); // picks up the new invoice counter in settings
        go('/invoice/' + encodeURIComponent(inv.number), { replace: true });
        if (res.emailError) toast('Invoice saved, but Gmail had a problem: ' + res.emailError, true);
        else toast(inv.status === 'sent' ? 'Invoice sent' : 'Draft ready in Gmail');
      });
    },
  };
}

function invoiceView(number) {
  const inv = state.invoices.find(i => i.number === number);
  if (!inv) return notFoundView();
  const cur = inv.currency;
  const dates = [`Issued ${h(fmtDate(inv.issueDate))}`];
  if (inv.sentAt) dates.push(`Sent ${h(fmtDate(inv.sentAt))}`);
  if (inv.paidAt) dates.push(`Paid ${h(fmtDate(inv.paidAt))}`);

  const buttons = [];
  if (inv.status === 'draft') {
    buttons.push('<a class="btn primary big" href="googlegmail://">Open Gmail to send it</a>');
  }
  if (inv.status === 'created') {
    buttons.push(`<button class="btn primary big" type="button" data-email>${h(sendLabel())}</button>`);
  }
  if (inv.pdfUrl) buttons.push(`<a class="btn" href="${h(inv.pdfUrl)}" target="_blank" rel="noopener">View PDF</a>`);
  if (inv.status === 'draft' || inv.status === 'sent') {
    buttons.push('<button class="btn" type="button" data-status="paid">Mark as paid</button>');
  }
  if (inv.status === 'draft') {
    buttons.push('<button class="btn" type="button" data-status="sent">I\'ve sent it</button>');
  }
  if (inv.status === 'paid') {
    buttons.push('<button class="btn" type="button" data-status="sent">Mark as not paid</button>');
  }

  const html = `
    <div class="card pad">
      <div class="detail-head"><h2>${h(inv.number)}</h2>${pill(inv)}</div>
      <div class="meta"><strong>${h(inv.clientName)}</strong> · ${h(inv.clientEmail)}<br>${dates.join(' · ')}</div>
    </div>
    <div class="section-title">Gigs</div>
    <div class="card list">
      ${inv.gigs.map(g => `
        <div>
          <div class="grow">
            <div class="primary">${h(g.venue)}</div>
            <div class="secondary">${h(fmtDate(g.date, true))}${g.description ? ' · ' + h(g.description) : ''}</div>
          </div>
          <div class="amount">${money(g.fee, cur)}</div>
        </div>`).join('')}
      <div class="total-row"><span class="grow">Total</span><span class="amount">${money(inv.total, cur)}</span></div>
    </div>
    <div class="stack">${buttons.join('')}</div>
    ${inv.status === 'draft'
      ? '<p class="hint">The invoice is in your Gmail Drafts folder. Once you\'ve sent it, this page updates by itself next time the app refreshes.</p>'
      : ''}
    ${inv.status !== 'created' && inv.status !== 'paid'
      ? `<p class="hint"><button class="link" type="button" data-email>${inv.status === 'draft' ? 'Draft missing? Make a new one' : 'Email it again'}</button></p>`
      : ''}`;

  return {
    title: 'Invoice',
    back: '/',
    tab: 'home',
    showError: true,
    html,
    bind(root) {
      root.querySelectorAll('[data-status]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const updated = await busy(btn, 'Saving…', () =>
            api('setInvoiceStatus', { number: inv.number, status: btn.dataset.status }));
          if (!updated) return;
          upsert(state.invoices, updated, 'number');
          saveCache();
          render();
          toast(updated.status === 'paid' ? 'Marked as paid' : 'Updated');
        });
      });
      root.querySelectorAll('[data-email]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const sending = state.settings && state.settings.sendMode === 'send';
          if (sending && !confirm(`Email invoice ${inv.number} to ${inv.clientEmail} now?`)) return;
          const updated = await busy(btn, sending ? 'Sending…' : 'Creating…', () =>
            api('emailInvoice', { number: inv.number }));
          if (!updated) return;
          upsert(state.invoices, updated, 'number');
          saveCache();
          render();
          toast(sending ? 'Invoice sent' : 'Draft ready in Gmail');
        });
      });
    },
  };
}

function clientsView() {
  const clients = sortedClients();
  const rows = clients.map(c => {
    const invoices = state.invoices.filter(i => i.clientId === c.id);
    const owed = invoices.filter(i => i.status !== 'paid').reduce((s, i) => s + i.total, 0);
    return `
      <a href="#/client/${h(c.id)}">
        <div class="grow">
          <div class="primary">${h(c.name)}</div>
          <div class="secondary">${h(c.email)}</div>
        </div>
        <div class="amount secondary">${owed ? money(owed) + ' due' : invoices.length + ' invoice' + (invoices.length === 1 ? '' : 's')}</div>
        <span class="chevron"></span>
      </a>`;
  }).join('');

  return {
    title: 'Clients',
    tab: 'clients',
    showError: true,
    html: `
      <div class="section-title">Clients <a href="#/client/new">＋ Add</a></div>
      <div class="card list">${rows || '<p class="empty">No clients yet.</p>'}</div>`,
  };
}

function clientView(id, query) {
  const client = id === 'new' ? null : clientById(id);
  if (id !== 'new' && !client) return notFoundView();
  const back = query.get('return') || '/clients';
  const values = client || { name: '', email: '', defaultFee: '' };
  const invoices = client ? sortedInvoices(state.invoices.filter(i => i.clientId === client.id)) : [];

  const html = `
    <form id="client-form" novalidate>
      <div class="card">
        <label class="field"><span>Name</span>
          <input name="name" value="${h(values.name)}" autocapitalize="words" autocomplete="off" enterkeyhint="next">
        </label>
        <label class="field"><span>Email</span>
          <input name="email" type="email" value="${h(values.email)}" autocapitalize="off" autocorrect="off" inputmode="email" enterkeyhint="next">
        </label>
        <label class="field"><span>Usual fee (optional, ${h(currency())})</span>
          <input name="defaultFee" value="${h(values.defaultFee === null ? '' : values.defaultFee)}" inputmode="decimal" placeholder="0.00">
        </label>
      </div>
      <div class="stack">
        <button class="btn primary" type="submit">${client ? 'Save changes' : 'Add client'}</button>
        ${client ? `<a class="btn" href="#/gig/new?client=${h(client.id)}&return=${encodeURIComponent('/client/' + client.id)}">＋ Log a gig for ${h(client.name)}</a>` : ''}
      </div>
    </form>
    ${invoices.length ? '<div class="section-title">Invoices</div><div class="card list">' + invoices.map(invoiceRow).join('') + '</div>' : ''}
    ${client ? '<div class="stack"><button class="btn danger" type="button" id="delete-client">Delete client</button></div>' : ''}`;

  return {
    title: client ? client.name : 'New client',
    back,
    tab: 'clients',
    html,
    bind(root) {
      const form = root.querySelector('#client-form');
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(form));
        if (client) data.id = client.id;
        const saved = await busy(form.querySelector('[type=submit]'), 'Saving…', () => api('saveClient', data));
        if (!saved) return;
        upsert(state.clients, saved);
        saveCache();
        toast(client ? 'Client updated' : 'Client added');
        go(query.get('return') ? withParam(back, 'client', saved.id) : '/clients');
      });
      const del = root.querySelector('#delete-client');
      if (del) {
        del.addEventListener('click', async () => {
          const kept = invoices.length ? ' Their past invoices will be kept.' : '';
          if (!confirm(`Delete ${client.name}?${kept}`)) return;
          const res = await busy(del, 'Deleting…', () => api('deleteClient', { id: client.id }));
          if (!res) return;
          state.clients = state.clients.filter(c => c.id !== client.id);
          saveCache();
          toast('Client deleted');
          go('/clients', { replace: true });
        });
      }
    },
  };
}

function settingsView() {
  const s = state.settings;
  const field = (name, label, attrs = '') =>
    `<label class="field"><span>${label}</span><input name="${name}" value="${h(s[name])}" ${attrs}></label>`;
  const area = (name, label, rows = 3) =>
    `<label class="field"><span>${label}</span><textarea name="${name}" rows="${rows}">${h(s[name])}</textarea></label>`;

  const connection = `
    <form id="connect-form" novalidate>
      <div class="section-title">Connection</div>
      <div class="card">
        <label class="field"><span>Web app URL</span>
          <input name="url" type="url" value="${h(config.url)}" placeholder="https://script.google.com/macros/s/…/exec" autocapitalize="off" autocorrect="off">
        </label>
        <label class="field"><span>API key</span>
          <input name="key" value="${h(config.key)}" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">
        </label>
      </div>
      <div class="stack"><button class="btn ${isConnected() ? '' : 'primary'}" type="submit">${isConnected() ? 'Update connection' : 'Connect'}</button></div>
      <p class="hint">Both come from the Apps Script setup steps in the README. They're stored only on this phone.</p>
    </form>`;

  const details = !s ? '' : `
    <form id="settings-form" novalidate>
      <div class="section-title">Your details (shown on invoices)</div>
      <div class="card">
        ${field('yourName', 'Name', 'autocapitalize="words"')}
        ${field('email', 'Email', 'type="email" autocapitalize="off" inputmode="email"')}
        ${field('phone', 'Phone', 'type="tel"')}
      </div>

      <div class="section-title">Payment</div>
      <div class="card">
        ${field('accountName', 'Account name', 'autocapitalize="words"')}
        ${field('iban', 'IBAN', 'autocapitalize="characters" autocorrect="off" spellcheck="false"')}
        ${field('bic', 'BIC', 'autocapitalize="characters" autocorrect="off" spellcheck="false"')}
        <label class="field"><span>Currency</span>
          <select name="currency">
            ${['EUR', 'GBP', 'USD'].map(c => `<option ${s.currency === c ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </label>
      </div>

      <div class="section-title">Invoices</div>
      <div class="card">
        <div class="row2">
          ${field('numberFormat', 'Number format', 'autocapitalize="off" autocorrect="off" spellcheck="false"')}
          ${field('nextNumber', 'Next number', 'inputmode="numeric"')}
        </div>
        ${field('defaultDescription', 'Usual gig description')}
        ${area('invoiceNote', 'Note at the bottom', 2)}
      </div>
      <p class="hint"><code>{YYYY}</code> is the year and <code>{NNN}</code> the counter, padded to 3 digits.
        With a year in the format, the counter restarts at 1 each January. Next invoice: <strong id="next-preview"></strong></p>

      <div class="section-title">Email</div>
      <div class="card">
        <label class="field"><span>When I create an invoice</span>
          <select name="sendMode">
            <option value="draft" ${s.sendMode === 'draft' ? 'selected' : ''}>Put it in my Gmail drafts</option>
            <option value="send" ${s.sendMode === 'send' ? 'selected' : ''}>Email it straight away</option>
          </select>
        </label>
        ${field('emailSubject', 'Subject')}
        ${area('emailBody', 'Message', 6)}
      </div>
      <p class="hint">You can use <code>{clientName}</code> <code>{number}</code> <code>{total}</code>
        <code>{issueDate}</code> <code>{venues}</code> <code>{yourName}</code>.</p>

      <div class="stack"><button class="btn primary" type="submit">Save settings</button></div>
    </form>`;

  return {
    title: 'Settings',
    tab: 'settings',
    showError: true,
    html: connection + details,
    bind(root) {
      const connect = root.querySelector('#connect-form');
      connect.addEventListener('submit', async e => {
        e.preventDefault();
        const next = { url: connect.url.value.trim(), key: connect.key.value.trim() };
        if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(next.url) && !/^http:\/\/localhost[:/]/.test(next.url)) {
          toast('The URL should start with https://script.google.com/ and end with /exec', true);
          return;
        }
        const previous = config;
        config = next;
        const data = await busy(connect.querySelector('[type=submit]'), 'Connecting…', () => api('load'));
        if (!data) {
          config = previous;
          return;
        }
        writeLocal(CONFIG_KEY, config);
        applyData(data);
        saveCache();
        state.error = '';
        state.lastSync = Date.now();
        toast('Connected');
        render();
      });

      const form = root.querySelector('#settings-form');
      if (!form) return;
      const preview = () => {
        const fmt = form.numberFormat.value || '{YYYY}-{NNN}';
        const year = today().slice(0, 4);
        root.querySelector('#next-preview').textContent = fmt
          .replace(/\{YYYY\}/g, year)
          .replace(/\{YY\}/g, year.slice(2))
          .replace(/\{(N+)\}/g, (m, ns) => String(form.nextNumber.value || 1).padStart(ns.length, '0'));
      };
      preview();
      form.numberFormat.addEventListener('input', preview);
      form.nextNumber.addEventListener('input', preview);
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const saved = await busy(form.querySelector('[type=submit]'), 'Saving…', () =>
          api('saveSettings', Object.fromEntries(new FormData(form))));
        if (!saved) return;
        state.settings = saved;
        saveCache();
        toast('Settings saved');
        render();
      });
    },
  };
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

function openSheet(title, html) {
  $('#sheet-title').textContent = title;
  $('#sheet-frame').srcdoc = html;
  $('#sheet').hidden = false;
}

function showSyncState() {
  const el = $('#sync');
  el.hidden = !state.syncing;
}

// ---------------------------------------------------------------------------
// Start up

$('#sheet-close').addEventListener('click', () => { $('#sheet').hidden = true; });
$('#toast').addEventListener('click', () => { $('#toast').hidden = true; });
$('#view').addEventListener('input', () => { formDirty = true; });
window.addEventListener('hashchange', () => {
  render();
  window.scrollTo(0, 0);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - state.lastSync > SYNC_INTERVAL_MS) sync();
});

const cached = readLocal(CACHE_KEY);
if (cached && isConnected()) applyData(cached);
render();
sync();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
