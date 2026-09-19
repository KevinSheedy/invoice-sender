// Runs the app locally against an in-memory fake of Google (Sheets, Drive, Gmail).
//   node dev/server.mjs            → http://localhost:8787, connect with URL http://localhost:8787/exec, key "dev"
//   node dev/server.mjs --seed     → same, with a few sample clients and gigs
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackend } from './fake-google.mjs';

const PORT = Number(process.env.PORT) || 8787;
const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

const backend = createBackend({ driveUrlBase: `http://localhost:${PORT}/fake-drive/`, log: m => console.log(m) });
backend.props.set('API_KEY', 'dev');
backend.context.setup();

if (process.argv.includes('--seed')) {
  const call = (a, d) => {
    const res = backend.call(a, d);
    if (!res.ok) throw new Error(res.error);
    return res.result;
  };
  call('saveSettings', {
    yourName: 'Sam Singer', email: 'sam@example.com',
    phone: '087 123 4567', accountName: 'S Singer', iban: 'IE12 BOFI 9000 0112 3456 78', bic: 'BOFIIE2D',
  });
  const crown = call('saveClient', { name: 'The Crown Bar', email: 'bookings@crownbar.ie', defaultFee: 250 });
  const wed = call('saveClient', { name: 'Ellen & Tom (wedding)', email: 'ellen@example.com' });
  call('saveGig', { clientId: crown.id, date: '2026-09-05', venue: 'The Crown Bar', description: 'Jazz trio vocals', fee: 250 });
  call('saveGig', { clientId: crown.id, date: '2026-09-12', venue: 'The Crown Bar', description: 'Jazz trio vocals', fee: 250 });
  const g = call('saveGig', { clientId: wed.id, date: '2026-08-22', venue: 'Tankardstown House', description: 'Ceremony & drinks reception', fee: 650 });
  call('createInvoice', { clientId: wed.id, gigIds: [g.id] });
  backend.sendDraft();
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/exec') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const out = req.method === 'POST'
      ? backend.context.doPost({ postData: { contents: body } })
      : backend.context.doGet();
    await new Promise(r => setTimeout(r, 400)); // Apps Script is never instant; keep the UI honest
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(out.getContent());
    return;
  }
  if (url.pathname.startsWith('/fake-drive/')) {
    const file = backend.files.get(url.pathname.slice('/fake-drive/'.length));
    if (!file) { res.writeHead(404); res.end('No such file'); return; }
    // The fake "PDF" is the invoice HTML, which is what the real PDF is rendered from.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(file.blob.getDataAsString());
    return;
  }
  if (url.pathname === '/fake-gmail') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(backend.mail, (k, v) => (k === 'attachments' ? v.map(a => a.getName()) : v), 2));
    return;
  }
  const path = normalize(join(WEB, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!path.startsWith(WEB)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Gig Invoices dev server: http://localhost:${PORT}`);
  console.log(`In Settings use URL http://localhost:${PORT}/exec and key "dev". Sent mail: /fake-gmail`);
});
