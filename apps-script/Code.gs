/**
 * Gig Invoices – Google Apps Script backend.
 *
 * Keeps clients, gigs and invoices in the Google Sheet this script is attached to,
 * saves invoice PDFs to a Drive folder, and creates Gmail drafts (or sends) from
 * your own Gmail account. The phone app talks to it through doPost().
 *
 * First time: run setup() from the editor, then Deploy → New deployment → Web app.
 * See README.md for the full steps.
 */

const TABLES = {
  Clients: ['id', 'name', 'email', 'address', 'defaultFee', 'createdAt'],
  Gigs: ['id', 'clientId', 'date', 'venue', 'description', 'fee', 'invoiceNumber', 'createdAt'],
  Invoices: ['number', 'clientId', 'clientName', 'clientEmail', 'clientAddress', 'issueDate',
    'dueDate', 'currency', 'total', 'gigs', 'status', 'pdfFileId', 'pdfUrl', 'emailedAt',
    'sentAt', 'paidAt', 'createdAt'],
  Settings: ['key', 'value'],
};

const DEFAULT_SETTINGS = {
  yourName: '',
  address: '',
  email: '',
  phone: '',
  accountName: '',
  iban: '',
  bic: '',
  currency: 'EUR',
  paymentTermsDays: '14',
  numberFormat: '{YYYY}-{NNN}',
  nextNumber: '1',
  numberYear: '',
  defaultDescription: 'Live vocal performance',
  invoiceNote: 'Thank you for booking me!',
  emailSubject: 'Invoice {number} from {yourName}',
  emailBody: 'Hi {clientName},\n\nPlease find attached invoice {number} for {total}, ' +
    'due by {dueDate}.\n\nMany thanks,\n{yourName}',
  sendMode: 'draft',
};

// numberYear is bookkeeping for the yearly reset, not something to edit.
const EDITABLE_SETTINGS = Object.keys(DEFAULT_SETTINGS).filter(k => k !== 'numberYear');

const ACTIONS = {
  load: () => withLock_(load_),
  saveClient: d => withLock_(() => saveClient_(d)),
  saveGig: d => withLock_(() => saveGig_(d)),
  deleteGig: d => withLock_(() => deleteGig_(d)),
  previewInvoice: d => previewInvoice_(d),
  createInvoice: d => withLock_(() => createInvoice_(d)),
  emailInvoice: d => withLock_(() => emailInvoice_(d)),
  setInvoiceStatus: d => withLock_(() => setInvoiceStatus_(d)),
  saveSettings: d => withLock_(() => saveSettings_(d)),
};

// ---------------------------------------------------------------------------
// Web app entry points

function doPost(e) {
  let request;
  try {
    request = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Bad request' });
  }
  if (!keyMatches_(request.key)) {
    return json_({ ok: false, error: 'The API key is wrong – check it in Settings' });
  }
  const action = ACTIONS[request.action];
  if (!action) return json_({ ok: false, error: 'Unknown action: ' + request.action });
  try {
    return json_({ ok: true, result: action(request.data || {}) });
  } catch (err) {
    return json_({ ok: false, error: err.message || String(err) });
  }
}

// Opening the web app URL in a browser shows this, which is a handy deployment check.
function doGet() {
  return json_({ ok: true, result: 'Gig Invoices is running' });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function keyMatches_(given) {
  const expected = PropertiesService.getScriptProperties().getProperty('API_KEY') || '';
  if (!expected || typeof given !== 'string' || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// One-off setup, run from the Apps Script editor

function setup() {
  const props = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.create('Gig Invoices');
  props.setProperty('SPREADSHEET_ID', ss.getId());

  Object.keys(TABLES).forEach(name => {
    const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, TABLES[name].length).setValues([TABLES[name]]).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
    // Plain text everywhere, so Sheets doesn't turn "2026-001" or "2026-09-19" into dates.
    sheet.getRange(1, 1, sheet.getMaxRows(), TABLES[name].length).setNumberFormat('@');
  });
  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);

  const saved = settingsRows_().map(r => r.key);
  const missing = {};
  Object.keys(DEFAULT_SETTINGS).forEach(k => {
    if (saved.indexOf(k) === -1) missing[k] = DEFAULT_SETTINGS[k];
  });
  writeSettings_(missing);

  invoiceFolder_();
  if (!props.getProperty('API_KEY')) {
    props.setProperty('API_KEY', Utilities.getUuid().replace(/-/g, ''));
  }
  Logger.log('Setup done. Your API key (paste it into the app\'s Settings): ' +
    props.getProperty('API_KEY'));
}

function showApiKey() {
  Logger.log(PropertiesService.getScriptProperties().getProperty('API_KEY'));
}

// Use this if the key ever leaks; the phone app then needs the new key.
function resetApiKey() {
  PropertiesService.getScriptProperties()
    .setProperty('API_KEY', Utilities.getUuid().replace(/-/g, ''));
  showApiKey();
}

// ---------------------------------------------------------------------------
// Actions

function load_() {
  refreshDraftStatuses_();
  return {
    clients: readTable_('Clients').map(clientOut_),
    gigs: readTable_('Gigs').map(gigOut_),
    invoices: readTable_('Invoices').map(invoiceOut_),
    settings: publicSettings_(readSettings_()),
  };
}

function saveClient_(d) {
  const name = str_(d.name);
  const email = str_(d.email);
  if (!name) throw new Error('Please enter the client\'s name');
  if (!isEmail_(email)) throw new Error('Please enter a valid email address');
  const defaultFee = str_(d.defaultFee) === '' ? '' : String(money_(d.defaultFee, 'Default fee'));

  const existing = d.id ? findRow_('Clients', 'id', d.id) : null;
  if (d.id && !existing) throw new Error('Client not found – try refreshing');
  const client = Object.assign({}, existing || { id: newId_(), createdAt: nowIso_() },
    { name, email, address: str_(d.address), defaultFee });
  writeRow_('Clients', client, existing && existing._row);
  return clientOut_(client);
}

function saveGig_(d) {
  if (!findRow_('Clients', 'id', d.clientId)) throw new Error('Please choose a client');
  const date = str_(d.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Please enter the gig date');
  const venue = str_(d.venue);
  if (!venue) throw new Error('Please enter the venue');
  const fee = money_(d.fee, 'Fee');

  const existing = d.id ? findRow_('Gigs', 'id', d.id) : null;
  if (d.id && !existing) throw new Error('Gig not found – try refreshing');
  if (existing && existing.invoiceNumber) {
    throw new Error('This gig is on invoice ' + existing.invoiceNumber + ' so it can\'t be changed');
  }
  const gig = Object.assign({}, existing || { id: newId_(), invoiceNumber: '', createdAt: nowIso_() },
    { clientId: d.clientId, date, venue, description: str_(d.description), fee: String(fee) });
  writeRow_('Gigs', gig, existing && existing._row);
  return gigOut_(gig);
}

function deleteGig_(d) {
  const gig = findRow_('Gigs', 'id', d.id);
  if (!gig) return { deleted: false };
  if (gig.invoiceNumber) {
    throw new Error('This gig is on invoice ' + gig.invoiceNumber + ' so it can\'t be deleted');
  }
  sheet_('Gigs').deleteRow(gig._row);
  return { deleted: true };
}

function previewInvoice_(d) {
  const settings = readSettings_();
  const inv = draftInvoice_(d, settings);
  inv.number = nextNumber_(settings, inv.issueDate, readTable_('Invoices')).number;
  return { number: inv.number, total: inv.total, html: renderInvoiceHtml_(inv, settings) };
}

function createInvoice_(d) {
  const settings = readSettings_();
  const inv = draftInvoice_(d, settings);
  const next = nextNumber_(settings, inv.issueDate, readTable_('Invoices'));
  inv.number = next.number;

  const pdf = renderPdf_(inv, settings);
  const file = invoiceFolder_().createFile(pdf);
  inv.pdfFileId = file.getId();
  inv.pdfUrl = file.getUrl();
  inv.status = 'created';
  inv.createdAt = nowIso_();

  const gigRows = inv._gigRows;
  delete inv._gigRows;
  const row = writeRow_('Invoices', invoiceRow_(inv));
  gigRows.forEach(g => writeRow_('Gigs', Object.assign({}, g, { invoiceNumber: inv.number }), g._row));
  writeSettings_({ nextNumber: String(next.n + 1), numberYear: next.year });

  // The invoice is saved at this point. If Gmail fails, the app offers to retry the email.
  let emailError = '';
  try {
    Object.assign(inv, emailPdf_(inv, pdf, d.mode || settings.sendMode, settings));
    writeRow_('Invoices', invoiceRow_(inv), row);
  } catch (err) {
    emailError = err.message || String(err);
  }
  return { invoice: invoiceOut_(inv), emailError };
}

function emailInvoice_(d) {
  const inv = findRow_('Invoices', 'number', d.number);
  if (!inv) throw new Error('Invoice not found – try refreshing');
  const settings = readSettings_();
  const pdf = DriveApp.getFileById(inv.pdfFileId).getBlob();
  const updated = Object.assign({}, inv, emailPdf_(invoiceOut_(inv), pdf, d.mode || settings.sendMode, settings));
  writeRow_('Invoices', updated, inv._row);
  return invoiceOut_(updated);
}

function setInvoiceStatus_(d) {
  const inv = findRow_('Invoices', 'number', d.number);
  if (!inv) throw new Error('Invoice not found – try refreshing');
  if (['sent', 'paid'].indexOf(d.status) === -1) throw new Error('Unknown status: ' + d.status);
  const updated = Object.assign({}, inv, { status: d.status });
  if (d.status === 'paid') updated.paidAt = today_();
  else updated.paidAt = '';
  if (d.status === 'sent' && !updated.sentAt) updated.sentAt = today_();
  writeRow_('Invoices', updated, inv._row);
  return invoiceOut_(updated);
}

function saveSettings_(d) {
  const current = readSettings_();
  const patch = {};
  EDITABLE_SETTINGS.forEach(k => {
    if (d[k] !== undefined && d[k] !== null) patch[k] = String(d[k]).trim();
  });
  if (patch.numberFormat !== undefined && !/\{N+\}/.test(patch.numberFormat)) {
    throw new Error('The invoice number format needs {N}, {NN}, {NNN} or {NNNN} for the counter');
  }
  if (patch.nextNumber !== undefined) {
    if (!/^\d+$/.test(patch.nextNumber) || Number(patch.nextNumber) < 1) {
      throw new Error('Next invoice number must be a whole number, 1 or more');
    }
    // A hand-set counter applies to this year, so the yearly reset shouldn't undo it.
    if (patch.nextNumber !== current.nextNumber) patch.numberYear = today_().slice(0, 4);
  }
  if (patch.paymentTermsDays !== undefined && !/^\d+$/.test(patch.paymentTermsDays)) {
    throw new Error('Payment terms must be a number of days');
  }
  if (patch.currency !== undefined) {
    patch.currency = patch.currency.toUpperCase();
    if (!/^[A-Z]{3}$/.test(patch.currency)) throw new Error('Currency must be a 3-letter code like EUR');
  }
  if (patch.sendMode !== undefined && ['draft', 'send'].indexOf(patch.sendMode) === -1) {
    throw new Error('Sending mode must be "draft" or "send"');
  }
  if (patch.email && !isEmail_(patch.email)) throw new Error('Your email address doesn\'t look right');
  writeSettings_(patch);
  return publicSettings_(readSettings_());
}

// ---------------------------------------------------------------------------
// Invoices

function draftInvoice_(d, settings) {
  const client = findRow_('Clients', 'id', d.clientId);
  if (!client) throw new Error('Please choose a client');
  const ids = Array.isArray(d.gigIds) ? d.gigIds.filter((id, i, all) => all.indexOf(id) === i) : [];
  if (!ids.length) throw new Error('Pick at least one gig to invoice');

  const allGigs = readTable_('Gigs');
  const gigs = ids.map(id => {
    const g = allGigs.find(x => x.id === id);
    if (!g) throw new Error('A gig wasn\'t found – try refreshing');
    if (g.clientId !== client.id) throw new Error('The gig at ' + g.venue + ' belongs to a different client');
    if (g.invoiceNumber) throw new Error('The gig at ' + g.venue + ' is already on invoice ' + g.invoiceNumber);
    return g;
  }).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const issueDate = today_();
  return {
    clientId: client.id,
    clientName: client.name,
    clientEmail: client.email,
    clientAddress: client.address,
    issueDate,
    dueDate: addDays_(issueDate, parseInt(settings.paymentTermsDays, 10) || 0),
    currency: settings.currency || 'EUR',
    total: round2_(gigs.reduce((sum, g) => sum + Number(g.fee), 0)),
    gigs: gigs.map(g => ({ id: g.id, date: g.date, venue: g.venue, description: g.description, fee: Number(g.fee) })),
    _gigRows: gigs,
  };
}

function nextNumber_(settings, issueDate, invoices) {
  const year = issueDate.slice(0, 4);
  let format = settings.numberFormat || DEFAULT_SETTINGS.numberFormat;
  if (!/\{N+\}/.test(format)) format += '-{NNN}';
  const yearly = /\{YY(YY)?\}/.test(format);
  let n = Math.max(1, parseInt(settings.nextNumber, 10) || 1);
  if (yearly && settings.numberYear && settings.numberYear !== year) n = 1;
  const taken = invoices.map(i => i.number);
  let number = formatNumber_(format, n, year);
  while (taken.indexOf(number) !== -1) number = formatNumber_(format, ++n, year);
  return { number, n, year };
}

function formatNumber_(format, n, year) {
  return format
    .replace(/\{YYYY\}/g, year)
    .replace(/\{YY\}/g, year.slice(2))
    .replace(/\{(N+)\}/g, (m, ns) => String(n).padStart(ns.length, '0'));
}

function emailPdf_(inv, pdf, mode, settings) {
  const vars = templateVars_(inv, settings);
  const subject = fill_(settings.emailSubject, vars);
  const body = fill_(settings.emailBody, vars);
  const options = { attachments: [pdf] };
  if (settings.yourName) options.name = settings.yourName;
  if (mode === 'send') {
    GmailApp.sendEmail(inv.clientEmail, subject, body, options);
    return { status: 'sent', emailedAt: nowIso_(), sentAt: today_() };
  }
  GmailApp.createDraft(inv.clientEmail, subject, body, options);
  return { status: 'draft', emailedAt: nowIso_() };
}

// Drafts get sent from the Gmail app, so look in Sent Mail to notice when that happened.
function refreshDraftStatuses_() {
  const drafts = readTable_('Invoices').filter(i => i.status === 'draft');
  drafts.forEach(inv => {
    try {
      const threads = GmailApp.search('in:sent to:' + inv.clientEmail + ' "' + inv.number + '"', 0, 1);
      if (threads.length) {
        const sentAt = Utilities.formatDate(threads[0].getLastMessageDate(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
        writeRow_('Invoices', Object.assign({}, inv, { status: 'sent', sentAt }), inv._row);
      }
    } catch (err) {
      // Not worth failing the whole load over; it'll be checked again next time.
    }
  });
}

function templateVars_(inv, s) {
  return {
    number: inv.number,
    clientName: inv.clientName,
    total: formatMoney_(inv.total, inv.currency),
    issueDate: formatDate_(inv.issueDate),
    dueDate: formatDate_(inv.dueDate),
    yourName: s.yourName,
    venues: inv.gigs.map(g => g.venue).filter((v, i, all) => all.indexOf(v) === i).join(', '),
  };
}

function fill_(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function renderPdf_(inv, settings) {
  const name = ('Invoice ' + inv.number + ' - ' + inv.clientName).replace(/[\\/:*?"<>|]/g, '');
  return Utilities.newBlob(renderInvoiceHtml_(inv, settings), MimeType.HTML, 'invoice.html')
    .getAs(MimeType.PDF)
    .setName(name + '.pdf');
}

function renderInvoiceHtml_(inv, s) {
  const e = escapeHtml_;
  const lines = v => e(v).replace(/\n/g, '<br>');
  const money = v => formatMoney_(v, inv.currency);
  const contact = [s.email, s.phone].filter(Boolean).map(e).join('<br>');
  const payment = [['Account name', s.accountName], ['IBAN', s.iban], ['BIC', s.bic]]
    .filter(p => p[1])
    .map(p => '<tr><td class="label">' + p[0] + '</td><td>' + e(p[1]) + '</td></tr>')
    .join('');
  const rows = inv.gigs.map(g =>
    '<tr class="item">' +
      '<td class="date">' + e(formatDate_(g.date)) + '</td>' +
      '<td>' + e(g.venue) + (g.description ? '<div class="muted">' + e(g.description) + '</div>' : '') + '</td>' +
      '<td class="num">' + money(g.fee) + '</td>' +
    '</tr>').join('');

  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>' +
      'body{font-family:Helvetica,Arial,sans-serif;color:#222;font-size:13px;line-height:1.45;margin:0;padding:24px;}' +
      '.page{max-width:680px;margin:0 auto;}' +
      'table{width:100%;border-collapse:collapse;}' +
      'td{vertical-align:top;padding:0;}' +
      'h1{font-size:30px;letter-spacing:2px;margin:0;color:#4a2c5e;}' +
      '.from{text-align:right;}' +
      '.from strong{font-size:15px;}' +
      '.muted{color:#777;font-size:12px;}' +
      '.label{color:#777;padding-right:14px;white-space:nowrap;}' +
      '.section{margin-top:32px;}' +
      '.heading{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#777;margin-bottom:4px;}' +
      '.items th{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#777;text-align:left;' +
        'border-bottom:2px solid #4a2c5e;padding:6px 0;}' +
      '.items td{border-bottom:1px solid #e3e3e3;padding:9px 0;}' +
      '.items .date{width:120px;white-space:nowrap;}' +
      '.num{text-align:right;white-space:nowrap;}' +
      '.items th.num{text-align:right;}' +
      '.total td{border-bottom:none;padding-top:12px;font-size:16px;font-weight:bold;}' +
      '.box{background:#f6f2f8;padding:12px 14px;}' +
      '.note{margin-top:28px;color:#555;}' +
    '</style></head><body><div class="page">' +
    '<table><tr>' +
      '<td><h1>INVOICE</h1></td>' +
      '<td class="from"><strong>' + e(s.yourName) + '</strong><br>' + lines(s.address) +
        (contact ? '<br>' + contact : '') + '</td>' +
    '</tr></table>' +
    '<table class="section"><tr>' +
      '<td><div class="heading">Bill to</div><strong>' + e(inv.clientName) + '</strong><br>' +
        lines(inv.clientAddress) + (inv.clientAddress ? '<br>' : '') + e(inv.clientEmail) + '</td>' +
      '<td style="width:240px"><table>' +
        '<tr><td class="label">Invoice no.</td><td><strong>' + e(inv.number) + '</strong></td></tr>' +
        '<tr><td class="label">Date</td><td>' + e(formatDate_(inv.issueDate)) + '</td></tr>' +
        '<tr><td class="label">Due</td><td>' + e(formatDate_(inv.dueDate)) + '</td></tr>' +
      '</table></td>' +
    '</tr></table>' +
    '<table class="section items">' +
      '<tr><th>Date</th><th>Details</th><th class="num">Amount</th></tr>' +
      rows +
      '<tr class="total"><td></td><td class="num">Total</td><td class="num">' + money(inv.total) + '</td></tr>' +
    '</table>' +
    (payment
      ? '<div class="section box"><div class="heading">Payment details</div><table>' + payment + '</table></div>'
      : '') +
    (s.invoiceNote ? '<div class="note">' + lines(s.invoiceNote) + '</div>' : '') +
    '</div></body></html>';
}

function invoiceFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FOLDER_ID');
  if (id) {
    try {
      return DriveApp.getFolderById(id);
    } catch (err) {
      // Folder was deleted; make a new one below.
    }
  }
  const folder = DriveApp.createFolder('Gig Invoices');
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

// ---------------------------------------------------------------------------
// Sheet storage. Rows are read by header name, so columns can be reordered safely.

function sheet_(name) {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Not set up yet – run setup() in the Apps Script editor');
  const sheet = SpreadsheetApp.openById(id).getSheetByName(name);
  if (!sheet) throw new Error('The ' + name + ' sheet is missing – run setup() again');
  return sheet;
}

function headers_(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
}

function readTable_(name) {
  const sheet = sheet_(name);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const headers = headers_(sheet);
  return sheet.getRange(2, 1, last - 1, headers.length).getValues()
    .map((values, i) => {
      const row = { _row: i + 2 };
      headers.forEach((h, j) => { row[h] = cell_(values[j]); });
      return row;
    })
    .filter(row => headers.some(h => row[h] !== ''));
}

function findRow_(name, column, value) {
  if (!value) return null;
  return readTable_(name).find(r => r[column] === value) || null;
}

// Writes obj to rowNumber, or appends it when rowNumber is empty. Returns the row number.
function writeRow_(name, obj, rowNumber) {
  const sheet = sheet_(name);
  const headers = headers_(sheet);
  const row = rowNumber || sheet.getLastRow() + 1;
  if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 100);
  const values = headers.map(h => (obj[h] === undefined || obj[h] === null ? '' : String(obj[h])));
  sheet.getRange(row, 1, 1, headers.length).setNumberFormat('@').setValues([values]);
  return row;
}

function cell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v === null || v === undefined ? '' : String(v).trim();
}

function settingsRows_() {
  return readTable_('Settings');
}

function readSettings_() {
  const s = Object.assign({}, DEFAULT_SETTINGS);
  settingsRows_().forEach(r => { if (r.key) s[r.key] = r.value; });
  return s;
}

function writeSettings_(patch) {
  const rows = settingsRows_();
  Object.keys(patch).forEach(key => {
    const existing = rows.find(r => r.key === key);
    const row = writeRow_('Settings', { key, value: patch[key] }, existing && existing._row);
    if (!existing) rows.push({ key, value: patch[key], _row: row });
  });
}

function publicSettings_(s) {
  const out = {};
  EDITABLE_SETTINGS.forEach(k => { out[k] = s[k]; });
  return out;
}

function clientOut_(r) {
  return { id: r.id, name: r.name, email: r.email, address: r.address,
    defaultFee: r.defaultFee === '' ? null : Number(r.defaultFee), createdAt: r.createdAt };
}

function gigOut_(r) {
  return { id: r.id, clientId: r.clientId, date: r.date, venue: r.venue, description: r.description,
    fee: Number(r.fee), invoiceNumber: r.invoiceNumber || '', createdAt: r.createdAt };
}

function invoiceOut_(r) {
  let gigs = r.gigs;
  if (typeof gigs === 'string') {
    try { gigs = JSON.parse(gigs); } catch (err) { gigs = []; }
  }
  const out = {};
  TABLES.Invoices.forEach(k => { out[k] = r[k] === undefined ? '' : r[k]; });
  out.total = Number(r.total);
  out.gigs = gigs || [];
  return out;
}

function invoiceRow_(inv) {
  return Object.assign({}, inv, { gigs: JSON.stringify(inv.gigs) });
}

// ---------------------------------------------------------------------------
// Small helpers

function now_() {
  return new Date();
}

function nowIso_() {
  return now_().toISOString();
}

function today_() {
  return Utilities.formatDate(now_(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function addDays_(isoDate, days) {
  const p = isoDate.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + days)).toISOString().slice(0, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate_(isoDate) {
  const p = String(isoDate || '').split('-').map(Number);
  if (p.length !== 3 || !p[0]) return String(isoDate || '');
  return p[2] + ' ' + MONTHS[p[1] - 1] + ' ' + p[0];
}

const CURRENCY_SYMBOLS = { EUR: '€', GBP: '£', USD: '$' };

function formatMoney_(value, currency) {
  const fixed = (Math.round(Number(value) * 100) / 100).toFixed(2);
  const parts = fixed.split('.');
  const whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = CURRENCY_SYMBOLS[currency];
  return symbol ? symbol + whole + '.' + parts[1] : whole + '.' + parts[1] + ' ' + currency;
}

function money_(value, label) {
  const n = Number(String(value === undefined || value === null ? '' : value).replace(/[€£$,\s]/g, ''));
  if (String(value).trim() === '' || !isFinite(n) || n < 0) throw new Error(label + ' must be an amount like 250 or 250.50');
  return round2_(n);
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}

function str_(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

function isEmail_(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function newId_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

function escapeHtml_(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
