import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from './fake-google.mjs';

function setUp() {
  const b = createBackend();
  b.setNow('2026-09-19T21:30:00Z');
  b.context.setup();
  return b;
}

function ok(res) {
  assert.equal(res.ok, true, res.error);
  return res.result;
}

function addClientWithGigs(b, fees = [250, 300]) {
  const client = ok(b.call('saveClient', { name: 'The Crown', email: 'bookings@crown.ie' }));
  const gigs = fees.map((fee, i) => ok(b.call('saveGig', {
    clientId: client.id, date: `2026-09-${String(10 + i).padStart(2, '0')}`, venue: `Venue ${i}`, fee,
  })));
  return { client, gigs };
}

test('setup creates tables, settings and an API key', () => {
  const b = setUp();
  const names = b.spreadsheet.getSheets().map(s => s.getName());
  assert.deepEqual(names, ['Clients', 'Gigs', 'Invoices', 'Settings']);
  assert.match(b.props.get('API_KEY'), /^[0-9a-f]{32}$/);
  const { settings } = ok(b.call('load'));
  assert.equal(settings.numberFormat, '{YYYY}-{NNN}');
  assert.equal(settings.numberYear, undefined, 'bookkeeping settings are not exposed');

  b.context.setup(); // running it again is harmless
  assert.equal(b.spreadsheet.getSheetByName('Settings').getLastRow(), 1 + 15);
});

test('rejects a wrong or missing key', () => {
  const b = setUp();
  assert.equal(b.call('load', {}, 'nope').ok, false);
  assert.equal(b.call('load', {}, null).ok, false);
});

test('validates clients and gigs', () => {
  const b = setUp();
  assert.match(b.call('saveClient', { name: 'X', email: 'not-an-email' }).error, /valid email/);
  const { client } = addClientWithGigs(b, []);
  assert.match(b.call('saveGig', { clientId: client.id, date: '', venue: 'V', fee: 1 }).error, /date/);
  assert.match(b.call('saveGig', { clientId: client.id, date: '2026-09-01', venue: 'V', fee: 'abc' }).error, /Fee/);
  assert.match(b.call('saveGig', { clientId: 'nope', date: '2026-09-01', venue: 'V', fee: 1 }).error, /client/);
  const gig = ok(b.call('saveGig', { clientId: client.id, date: '2026-09-01', venue: 'V', fee: '€1,200.50' }));
  assert.equal(gig.fee, 1200.5);
});

test('edits a client in place', () => {
  const b = setUp();
  const { client } = addClientWithGigs(b, []);
  ok(b.call('saveClient', { ...client, email: 'new@crown.ie', defaultFee: '275' }));
  const { clients } = ok(b.call('load'));
  assert.equal(clients.length, 1);
  assert.equal(clients[0].email, 'new@crown.ie');
  assert.equal(clients[0].defaultFee, 275);
});

test('creates an invoice as a Gmail draft with the PDF attached', () => {
  const b = setUp();
  ok(b.call('saveSettings', { yourName: 'Kev <Singer>', iban: 'IE00 TEST 1234' }));
  const { client, gigs } = addClientWithGigs(b);

  const preview = ok(b.call('previewInvoice', { clientId: client.id, gigIds: gigs.map(g => g.id) }));
  assert.equal(preview.number, '2026-001');
  assert.equal(preview.total, 550);
  assert.match(preview.html, /Kev &lt;Singer&gt;/, 'user text is escaped');
  assert.match(preview.html, /€550\.00/);
  assert.match(preview.html, /IE00 TEST 1234/);

  const { invoice, emailError } = ok(b.call('createInvoice', { clientId: client.id, gigIds: gigs.map(g => g.id) }));
  assert.equal(emailError, '');
  assert.equal(invoice.number, '2026-001');
  assert.equal(invoice.status, 'draft');
  assert.equal(invoice.issueDate, '2026-09-19');
  assert.equal(invoice.dueDate, undefined);
  assert.equal(invoice.gigs.length, 2);

  assert.equal(b.mail.drafts.length, 1);
  const draft = b.mail.drafts[0];
  assert.equal(draft.to, 'bookings@crown.ie');
  assert.equal(draft.subject, 'Invoice 2026-001 from Kev <Singer>');
  assert.match(draft.body, /invoice 2026-001 for €550\.00\.\n/);
  assert.doesNotMatch(preview.html, /Due|Main St/);
  assert.equal(draft.options.attachments[0].getContentType(), 'application/pdf');
  assert.equal(draft.options.attachments[0].getName(), 'Invoice 2026-001 - The Crown.pdf');

  const state = ok(b.call('load'));
  assert.ok(state.gigs.every(g => g.invoiceNumber === '2026-001'));
  assert.equal(state.invoices.length, 1);
});

test('does not invoice a gig twice or edit an invoiced gig', () => {
  const b = setUp();
  const { client, gigs } = addClientWithGigs(b);
  ok(b.call('createInvoice', { clientId: client.id, gigIds: [gigs[0].id] }));
  assert.match(b.call('createInvoice', { clientId: client.id, gigIds: [gigs[0].id] }).error, /already on invoice 2026-001/);
  assert.match(b.call('saveGig', { ...gigs[0], fee: 1 }).error, /can't be changed/);
  assert.match(b.call('deleteGig', { id: gigs[0].id }).error, /can't be deleted/);
  assert.equal(ok(b.call('deleteGig', { id: gigs[1].id })).deleted, true);
  assert.equal(ok(b.call('load')).gigs.length, 1);
});

test('deletes a client but keeps their invoices', () => {
  const b = setUp();
  const { client, gigs } = addClientWithGigs(b);
  ok(b.call('createInvoice', { clientId: client.id, gigIds: [gigs[0].id] }));
  assert.match(b.call('deleteClient', { id: client.id }).error, /1 gig not invoiced yet – invoice or delete it first/);

  ok(b.call('deleteGig', { id: gigs[1].id }));
  assert.equal(ok(b.call('deleteClient', { id: client.id })).deleted, true);
  const state = ok(b.call('load'));
  assert.equal(state.clients.length, 0);
  assert.equal(state.invoices[0].clientName, 'The Crown');
  assert.equal(ok(b.call('deleteClient', { id: client.id })).deleted, false);
});

test('rejects gigs from a different client', () => {
  const b = setUp();
  const { gigs } = addClientWithGigs(b);
  const other = ok(b.call('saveClient', { name: 'Other', email: 'o@x.ie' }));
  assert.match(b.call('createInvoice', { clientId: other.id, gigIds: [gigs[0].id] }).error, /different client/);
});

test('numbers invoices in sequence and restarts each year', () => {
  const b = setUp();
  const { client, gigs } = addClientWithGigs(b, [1, 2, 3]);
  assert.equal(ok(b.call('createInvoice', { clientId: client.id, gigIds: [gigs[0].id] })).invoice.number, '2026-001');
  assert.equal(ok(b.call('createInvoice', { clientId: client.id, gigIds: [gigs[1].id] })).invoice.number, '2026-002');
  b.setNow('2027-01-04T10:00:00Z');
  assert.equal(ok(b.call('createInvoice', { clientId: client.id, gigIds: [gigs[2].id] })).invoice.number, '2027-001');
});

test('can continue an existing numbering scheme', () => {
  const b = setUp();
  ok(b.call('saveSettings', { numberFormat: 'KS-{NNNN}', nextNumber: '42' }));
  const { client, gigs } = addClientWithGigs(b, [1, 2]);
  assert.equal(ok(b.call('createInvoice', { clientId: client.id, gigIds: [gigs[0].id] })).invoice.number, 'KS-0042');
  b.setNow('2027-01-04T10:00:00Z');
  assert.equal(ok(b.call('createInvoice', { clientId: client.id, gigIds: [gigs[1].id] })).invoice.number, 'KS-0043',
    'no yearly reset without a year in the format');
});

test('a hand-set counter is not undone by the yearly reset', () => {
  const b = setUp();
  const { client, gigs } = addClientWithGigs(b, [1, 2]);
  ok(b.call('createInvoice', { clientId: client.id, gigIds: [gigs[0].id] }));
  b.setNow('2027-01-04T10:00:00Z');
  ok(b.call('saveSettings', { nextNumber: '5' }));
  assert.equal(ok(b.call('createInvoice', { clientId: client.id, gigIds: [gigs[1].id] })).invoice.number, '2027-005');
});

test('skips numbers that are already used', () => {
  const b = setUp();
  const { client, gigs } = addClientWithGigs(b, [1, 2]);
  ok(b.call('createInvoice', { clientId: client.id, gigIds: [gigs[0].id] }));
  ok(b.call('saveSettings', { nextNumber: '1' }));
  assert.equal(ok(b.call('createInvoice', { clientId: client.id, gigIds: [gigs[1].id] })).invoice.number, '2026-002');
});

test('notices when a draft has been sent from Gmail, then tracks payment', () => {
  const b = setUp();
  const { client, gigs } = addClientWithGigs(b);
  ok(b.call('createInvoice', { clientId: client.id, gigIds: [gigs[0].id] }));
  assert.equal(ok(b.call('load')).invoices[0].status, 'draft');
  b.sendDraft();
  const sent = ok(b.call('load')).invoices[0];
  assert.equal(sent.status, 'sent');
  assert.equal(sent.sentAt, '2026-09-19');
  const paid = ok(b.call('setInvoiceStatus', { number: '2026-001', status: 'paid' }));
  assert.equal(paid.status, 'paid');
  assert.equal(paid.paidAt, '2026-09-19');
  const unpaid = ok(b.call('setInvoiceStatus', { number: '2026-001', status: 'sent' }));
  assert.equal(unpaid.paidAt, '');
});

test('send mode emails directly', () => {
  const b = setUp();
  const { client, gigs } = addClientWithGigs(b);
  const { invoice } = ok(b.call('createInvoice', { clientId: client.id, gigIds: [gigs[0].id], mode: 'send' }));
  assert.equal(invoice.status, 'sent');
  assert.equal(b.mail.sent.length, 1);
  assert.equal(b.mail.drafts.length, 0);
});

test('keeps the invoice when Gmail fails, and the email can be retried', () => {
  const b = setUp();
  const { client, gigs } = addClientWithGigs(b);
  const createDraft = b.context.GmailApp.createDraft;
  b.context.GmailApp.createDraft = () => { throw new Error('Gmail is down'); };
  const res = ok(b.call('createInvoice', { clientId: client.id, gigIds: [gigs[0].id] }));
  assert.equal(res.emailError, 'Gmail is down');
  assert.equal(res.invoice.status, 'created');
  assert.equal(ok(b.call('load')).invoices[0].status, 'created');

  b.context.GmailApp.createDraft = createDraft;
  const retried = ok(b.call('emailInvoice', { number: '2026-001' }));
  assert.equal(retried.status, 'draft');
  assert.equal(retried.gigs.length, 1);
  assert.equal(b.mail.drafts[0].options.attachments[0].getName(), 'Invoice 2026-001 - The Crown.pdf');
});

test('validates settings and ignores unknown keys', () => {
  const b = setUp();
  assert.match(b.call('saveSettings', { numberFormat: '{YYYY}' }).error, /\{N\}/);
  assert.match(b.call('saveSettings', { nextNumber: '0' }).error, /whole number/);
  assert.match(b.call('saveSettings', { sendMode: 'yolo' }).error, /draft/);
  const s = ok(b.call('saveSettings', { currency: 'gbp', hacker: 'x' }));
  assert.equal(s.currency, 'GBP');
  assert.equal(s.hacker, undefined);
});

test('grows the sheet when it runs out of rows', () => {
  const b = setUp();
  b.spreadsheet.getSheetByName('Clients').maxRows = 2;
  ok(b.call('saveClient', { name: 'A', email: 'a@x.ie' }));
  ok(b.call('saveClient', { name: 'B', email: 'b@x.ie' }));
  assert.equal(ok(b.call('load')).clients.length, 2);
});
