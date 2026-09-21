import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from './fake-google.mjs';

function setUp() {
  const b = createBackend();
  b.setNow('2026-09-21T21:30:00Z');
  b.context.setup();
  return b;
}

function ok(res) {
  assert.equal(res.ok, true, res.error);
  return res.result;
}

const gig = (over = {}) => ({ date: '2026-08-26', venue: "St Patrick's Cathedral", fee: 125, ...over });

// What the app sends from its Settings screen.
const ME = {
  name: 'Sam Singer', email: 'sam@example.com', phone: '087 123 4567',
  accountName: 'S Singer', iban: 'IE12 BOFI 9000 0112', bic: 'BOFIIE2D',
};
const call = (b, action, data) => b.call(action, { me: ME, ...data });

test('setup makes an API key, and a wrong key is refused', () => {
  const b = setUp();
  assert.match(b.props.get('API_KEY'), /^[0-9a-f]{32}$/);
  assert.equal(b.call('config', {}, 'nope').ok, false);
  assert.equal(b.call('config', {}, null).ok, false);
  assert.match(b.call('nonsense', {}).error, /Unknown action/);
});

test('config lists the built-in clients', () => {
  const b = setUp();
  const { clients, currency } = ok(b.call('config'));
  assert.equal(currency, 'EUR');
  assert.deepEqual(clients, [
    { id: 'john', name: 'John McGlynn', email: 'angel@anuna.ie', defaultFee: 125, method: 'body' },
    { id: 'ardu', name: 'Ardú', email: 'ardumusic@gmail.com', defaultFee: null, method: 'pdf' },
  ]);
});

test('drafts an invoice in the email body for John', () => {
  const b = setUp();
  const res = ok(call(b, 'createDraft', { clientId: 'john', gigs: [gig()] }));
  assert.equal(res.method, 'body', 'falls back to the client\'s own method');
  assert.equal(res.to, 'angel@anuna.ie');
  assert.equal(res.subject, "Invoice for performance at St Patrick's Cathedral 2026-08-26");
  assert.equal(res.total, 125);

  assert.equal(b.drafts.length, 1);
  const draft = b.drafts[0];
  assert.equal(draft.options.attachments, undefined, 'nothing is attached');
  assert.equal(draft.options.name, 'Sam Singer');
  assert.match(draft.options.htmlBody, /<p>Hi John McGlynn,<\/p>/);
  assert.match(draft.options.htmlBody, /INVOICE/);
  assert.match(draft.options.htmlBody, /St Patrick&#39;s Cathedral/, 'client text is escaped');
  assert.match(draft.options.htmlBody, /€125\.00/);
  assert.match(draft.options.htmlBody, /IE12 BOFI 9000 0112/);
  assert.match(draft.options.htmlBody, /<p>Many thanks,<br>Sam Singer<\/p>/);
  assert.doesNotMatch(draft.options.htmlBody, /<style/, 'styles are inline, since Gmail strips <style>');

  // The plain-text fallback carries the same invoice.
  assert.match(draft.body, /26 Aug 2026 – Performance at St Patrick's Cathedral – €125\.00/);
  assert.match(draft.body, /Total: €125\.00/);
  assert.match(draft.body, /IBAN: IE12 BOFI 9000 0112/);
});

test('drafts an invoice as a PDF for Ardú', () => {
  const b = setUp();
  const res = ok(call(b, 'createDraft', { clientId: 'ardu', gigs: [gig({ venue: 'Christ Church', fee: '€300' })] }));
  assert.equal(res.method, 'pdf');
  assert.equal(res.to, 'ardumusic@gmail.com');
  assert.equal(res.total, 300);

  const draft = b.drafts[0];
  assert.equal(draft.options.htmlBody, undefined);
  assert.equal(draft.options.attachments.length, 1);
  assert.equal(draft.options.attachments[0].getContentType(), 'application/pdf');
  assert.equal(draft.options.attachments[0].getName(), 'Invoice 2026-09-21 - Ardú.pdf');
  assert.match(draft.options.attachments[0].getDataAsString(), /€300\.00/);
  assert.equal(draft.body, 'Hi Ardú,\n\nPlease find my invoice attached, for €300.00.\n\nMany thanks,\nSam Singer');
});

test('the method can be switched per invoice', () => {
  const b = setUp();
  ok(call(b, 'createDraft', { clientId: 'john', gigs: [gig()], method: 'pdf' }));
  assert.equal(b.drafts[0].options.attachments.length, 1);
  ok(call(b, 'createDraft', { clientId: 'ardu', gigs: [gig()], method: 'body' }));
  assert.ok(b.drafts[1].options.htmlBody);
});

test('takes a one-off client, defaulting to a PDF', () => {
  const b = setUp();
  const res = ok(call(b, 'createDraft', {
    clientName: 'The Crown Bar', clientEmail: 'bookings@crownbar.ie', gigs: [gig({ venue: 'The Crown Bar', fee: 250 })],
  }));
  assert.equal(res.to, 'bookings@crownbar.ie');
  assert.equal(res.method, 'pdf');
  assert.match(b.drafts[0].options.attachments[0].getName(), /The Crown Bar\.pdf$/);
});

test('bills several gigs on one invoice, oldest first', () => {
  const b = setUp();
  const res = ok(call(b, 'createDraft', {
    clientId: 'ardu',
    gigs: [gig({ date: '2026-09-12', venue: 'Whelan\'s', fee: 200 }), gig({ date: '2026-09-05', venue: 'The Crown', fee: 250 })],
  }));
  assert.equal(res.total, 450);
  assert.equal(res.subject, "Invoice for performance at The Crown, Whelan's 2026-09-05, 2026-09-12");
  const pdf = b.drafts[0].options.attachments[0].getDataAsString();
  assert.ok(pdf.indexOf('The Crown') < pdf.indexOf('Whelan'), 'listed oldest first');
  assert.match(pdf, /€450\.00/);
});

test('rejects incomplete invoices', () => {
  const b = setUp();
  assert.match(call(b, 'createDraft', { clientId: 'john', gigs: [] }).error, /at least one gig/);
  assert.match(call(b, 'createDraft', { clientId: 'nope', gigs: [gig()] }).error, /Unknown client/);
  assert.match(call(b, 'createDraft', { clientId: 'john', gigs: [gig({ date: '' })] }).error, /date of each gig/);
  assert.match(call(b, 'createDraft', { clientId: 'john', gigs: [gig({ venue: '' })] }).error, /venue for each gig/);
  assert.match(call(b, 'createDraft', { clientId: 'john', gigs: [gig({ fee: 'lots' })] }).error, /fee for each gig/);
  assert.match(call(b, 'createDraft', { clientName: 'X', clientEmail: 'nope', gigs: [gig()] }).error, /valid email/);
  assert.match(call(b, 'createDraft', { clientEmail: 'x@y.ie', gigs: [gig()] }).error, /client's name/);
  assert.equal(b.drafts.length, 0, 'nothing is drafted when something is wrong');
});

test('needs your name before it will draft anything', () => {
  const b = setUp();
  assert.match(b.call('createDraft', { clientId: 'john', gigs: [gig()] }).error, /your name and bank details/);
  assert.match(b.call('createDraft', { me: { iban: 'IE12' }, clientId: 'john', gigs: [gig()] }).error, /your name/);
  assert.equal(b.drafts.length, 0);

  // Only the name is required; the rest just stay off the invoice.
  const res = ok(b.call('createDraft', { me: { name: 'Sam Singer' }, clientId: 'ardu', gigs: [gig()] }));
  assert.equal(res.to, 'ardumusic@gmail.com');
  const pdf = b.drafts[0].options.attachments[0].getDataAsString();
  assert.doesNotMatch(pdf, /Payment details/);
});

test('preview returns the same invoice without drafting anything', () => {
  const b = setUp();
  const res = ok(call(b, 'preview', { clientId: 'john', gigs: [gig()] }));
  assert.equal(res.subject, "Invoice for performance at St Patrick's Cathedral 2026-08-26");
  assert.equal(res.total, 125);
  assert.match(res.html, /€125\.00/);
  assert.equal(b.drafts.length, 0);
});
