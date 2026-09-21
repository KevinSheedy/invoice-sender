/**
 * Gig Invoices – Google Apps Script backend.
 *
 * Renders an invoice and leaves it in your Gmail drafts, either as an attached PDF or as the
 * body of the email. Nothing is stored: no spreadsheet, no Drive files, no history. Your sent
 * mail is the record.
 *
 * Your own name and bank details are kept in the phone app and arrive with each request. Your
 * clients and the email wording live in CONFIG below; edit them here, then run
 * `npm run deploy:script` (see README).
 */

const CONFIG = {
  currency: 'EUR',

  // method: 'body' puts the invoice in the email itself, 'pdf' attaches it as a PDF. The app
  // starts on the client's method and lets you switch it for any one invoice.
  clients: [
    { id: 'john', name: 'John McGlynn', email: 'angel@anuna.ie', defaultFee: 125, method: 'body' },
    { id: 'ardu', name: 'Ardú', email: 'ardumusic@gmail.com', defaultFee: null, method: 'pdf' },
  ],

  lineDescription: 'Performance at {venue}',
  subject: 'Invoice for performance at {venues} {gigDates}',
  greeting: 'Hi {clientName},',
  attachedMessage: 'Please find my invoice attached, for {total}.',
  signOff: 'Many thanks,\n{yourName}',
  note: 'Thank you for booking me!',
};

const ACTIONS = {
  config: () => config_(),
  preview: d => preview_(d),
  createDraft: d => createDraft_(d),
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

// ---------------------------------------------------------------------------
// Run these from the Apps Script editor

function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('API_KEY')) {
    props.setProperty('API_KEY', Utilities.getUuid().replace(/-/g, ''));
  }
  showApiKey();
}

function showApiKey() {
  Logger.log('API key (paste it into the app\'s Settings): ' +
    PropertiesService.getScriptProperties().getProperty('API_KEY'));
}

// Use this if the key ever leaks; the phone app then needs the new key.
function resetApiKey() {
  PropertiesService.getScriptProperties()
    .setProperty('API_KEY', Utilities.getUuid().replace(/-/g, ''));
  showApiKey();
}

// ---------------------------------------------------------------------------
// Actions

function config_() {
  return {
    currency: CONFIG.currency,
    clients: CONFIG.clients.map(c => ({
      id: c.id,
      name: c.name,
      email: c.email,
      defaultFee: c.defaultFee === undefined ? null : c.defaultFee,
      method: c.method === 'body' ? 'body' : 'pdf',
    })),
  };
}

function preview_(d) {
  const inv = buildInvoice_(d);
  return {
    subject: subject_(inv),
    to: inv.client.email,
    method: inv.method,
    total: inv.total,
    html: invoiceHtml_(inv),
  };
}

function createDraft_(d) {
  const inv = buildInvoice_(d);
  const subject = subject_(inv);
  const vars = vars_(inv);
  const options = { name: inv.me.name };
  let body;

  if (inv.method === 'pdf') {
    body = [fill_(CONFIG.greeting, vars), fill_(CONFIG.attachedMessage, vars),
      fill_(CONFIG.signOff, vars)].join('\n\n');
    options.attachments = [Utilities.newBlob(invoiceHtml_(inv), MimeType.HTML, 'invoice.html')
      .getAs(MimeType.PDF)
      .setName(pdfName_(inv))];
  } else {
    body = invoiceText_(inv);
    options.htmlBody = '<p>' + escapeHtml_(fill_(CONFIG.greeting, vars)) + '</p>' +
      invoiceHtml_(inv) +
      '<p>' + escapeHtml_(fill_(CONFIG.signOff, vars)).replace(/\n/g, '<br>') + '</p>';
  }

  GmailApp.createDraft(inv.client.email, subject, body, options);
  return { subject: subject, to: inv.client.email, method: inv.method, total: inv.total };
}

// ---------------------------------------------------------------------------
// Building an invoice

function buildInvoice_(d) {
  const me = resolveMe_(d);
  const client = resolveClient_(d);
  const gigs = (Array.isArray(d.gigs) ? d.gigs : []).map(parseGig_)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!gigs.length) throw new Error('Add at least one gig');
  return {
    me,
    client,
    gigs,
    method: ['pdf', 'body'].indexOf(d.method) === -1 ? client.method : d.method,
    date: today_(),
    currency: CONFIG.currency,
    total: round2_(gigs.reduce((sum, g) => sum + g.fee, 0)),
  };
}

// Your details come from the app's Settings screen, which keeps them on your phone.
function resolveMe_(d) {
  const me = d.me || {};
  const name = str_(me.name);
  if (!name) throw new Error('Add your name and bank details in Settings first');
  return {
    name,
    email: str_(me.email),
    phone: str_(me.phone),
    accountName: str_(me.accountName),
    iban: str_(me.iban),
    bic: str_(me.bic),
  };
}

function resolveClient_(d) {
  if (d.clientId) {
    const known = CONFIG.clients.filter(c => c.id === d.clientId)[0];
    if (!known) throw new Error('Unknown client: ' + d.clientId);
    return { name: known.name, email: known.email, method: known.method === 'body' ? 'body' : 'pdf' };
  }
  const name = str_(d.clientName);
  const email = str_(d.clientEmail);
  if (!name) throw new Error('Enter the client\'s name');
  if (!isEmail_(email)) throw new Error('Enter a valid email address for the client');
  return { name, email, method: 'pdf' };
}

function parseGig_(g) {
  const date = str_(g && g.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Enter the date of each gig');
  const venue = str_(g.venue);
  if (!venue) throw new Error('Enter the venue for each gig');
  return { date, venue, fee: money_(g.fee) };
}

function subject_(inv) {
  return fill_(CONFIG.subject, vars_(inv));
}

function vars_(inv) {
  return {
    clientName: inv.client.name,
    yourName: inv.me.name,
    total: formatMoney_(inv.total, inv.currency),
    date: formatDate_(inv.date),
    venues: unique_(inv.gigs.map(g => g.venue)).join(', '),
    gigDates: unique_(inv.gigs.map(g => g.date)).sort().join(', '),
  };
}

function fill_(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function pdfName_(inv) {
  return ('Invoice ' + inv.date + ' - ' + inv.client.name).replace(/[\\/:*?"<>|]/g, '') + '.pdf';
}

// ---------------------------------------------------------------------------
// Rendering. Styles are inline so the same HTML works as a PDF and inside an email,
// where <style> blocks are often stripped.

function invoiceHtml_(inv) {
  const e = escapeHtml_;
  const money = v => formatMoney_(v, inv.currency);
  const text = '#222222';
  const muted = '#777777';
  const accent = '#4a2c5e';
  const cell = 'padding:9px 0;border-bottom:1px solid #e3e3e3;font-size:13px;color:' + text + ';';
  const head = 'padding:6px 0;border-bottom:2px solid ' + accent + ';font-size:11px;letter-spacing:1px;' +
    'text-transform:uppercase;color:' + muted + ';text-align:left;';
  const label = 'font-size:11px;letter-spacing:1px;text-transform:uppercase;color:' + muted + ';';
  const totalCell = 'padding-top:12px;text-align:right;font-size:16px;font-weight:bold;';
  const contact = [inv.me.email, inv.me.phone].filter(Boolean).map(e).join('<br>');
  const payment = [['Account name', inv.me.accountName], ['IBAN', inv.me.iban], ['BIC', inv.me.bic]]
    .filter(p => p[1])
    .map(p => '<tr><td style="padding:1px 14px 1px 0;color:' + muted + ';white-space:nowrap;">' + p[0] +
      '</td><td style="padding:1px 0;">' + e(p[1]) + '</td></tr>')
    .join('');
  const rows = inv.gigs.map(g =>
    '<tr>' +
      '<td style="' + cell + 'width:110px;white-space:nowrap;">' + e(formatDate_(g.date)) + '</td>' +
      '<td style="' + cell + '">' + e(fill_(CONFIG.lineDescription, { venue: g.venue })) + '</td>' +
      '<td style="' + cell + 'text-align:right;white-space:nowrap;">' + money(g.fee) + '</td>' +
    '</tr>').join('');

  return '' +
    '<div style="font-family:Helvetica,Arial,sans-serif;color:' + text + ';font-size:13px;' +
      'line-height:1.45;max-width:680px;">' +
      '<table style="width:100%;border-collapse:collapse;"><tr>' +
        '<td style="font-size:26px;letter-spacing:2px;color:' + accent + ';font-weight:bold;">INVOICE</td>' +
        '<td style="text-align:right;">' +
          '<strong style="font-size:15px;">' + e(inv.me.name) + '</strong>' +
          (contact ? '<br>' + contact : '') +
        '</td>' +
      '</tr></table>' +
      '<table style="width:100%;border-collapse:collapse;margin-top:28px;"><tr>' +
        '<td style="vertical-align:top;">' +
          '<div style="' + label + '">Bill to</div>' +
          '<strong>' + e(inv.client.name) + '</strong><br>' + e(inv.client.email) +
        '</td>' +
        '<td style="vertical-align:top;text-align:right;">' +
          '<span style="color:' + muted + ';">Date</span>&nbsp;&nbsp;' + e(formatDate_(inv.date)) +
        '</td>' +
      '</tr></table>' +
      '<table style="width:100%;border-collapse:collapse;margin-top:24px;">' +
        '<tr><th style="' + head + '">Date</th><th style="' + head + '">Details</th>' +
          '<th style="' + head + 'text-align:right;">Amount</th></tr>' +
        rows +
        '<tr><td></td><td style="' + totalCell + '">Total</td>' +
          '<td style="' + totalCell + 'white-space:nowrap;">' + money(inv.total) + '</td></tr>' +
      '</table>' +
      (payment
        ? '<div style="margin-top:28px;background:#f6f2f8;padding:12px 14px;">' +
            '<div style="' + label + 'margin-bottom:4px;">Payment details</div>' +
            '<table style="border-collapse:collapse;font-size:13px;">' + payment + '</table></div>'
        : '') +
      (CONFIG.note ? '<div style="margin-top:24px;color:#555555;">' + e(CONFIG.note) + '</div>' : '') +
    '</div>';
}

// Plain-text version, used as the fallback for email clients that don't show HTML.
function invoiceText_(inv) {
  const vars = vars_(inv);
  const lines = [fill_(CONFIG.greeting, vars), '', 'INVOICE – ' + formatDate_(inv.date), ''];
  inv.gigs.forEach(g => {
    lines.push(formatDate_(g.date) + ' – ' + fill_(CONFIG.lineDescription, { venue: g.venue }) +
      ' – ' + formatMoney_(g.fee, inv.currency));
  });
  lines.push('', 'Total: ' + formatMoney_(inv.total, inv.currency));
  [['Account name', inv.me.accountName], ['IBAN', inv.me.iban], ['BIC', inv.me.bic]]
    .filter(p => p[1])
    .forEach((p, i) => {
      if (i === 0) lines.push('');
      lines.push(p[0] + ': ' + p[1]);
    });
  lines.push('', fill_(CONFIG.signOff, vars));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Small helpers

function now_() {
  return new Date();
}

function today_() {
  return Utilities.formatDate(now_(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
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

function money_(value) {
  const n = Number(String(value === undefined || value === null ? '' : value).replace(/[€£$,\s]/g, ''));
  if (String(value).trim() === '' || !isFinite(n) || n < 0) {
    throw new Error('Enter the fee for each gig, like 250 or 250.50');
  }
  return round2_(n);
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}

function unique_(values) {
  return values.filter((v, i, all) => all.indexOf(v) === i);
}

function str_(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

function isEmail_(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function escapeHtml_(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
