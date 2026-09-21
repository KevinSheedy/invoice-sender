// Runs the app locally against an in-memory fake of Gmail.
//   node dev/server.mjs   → http://localhost:8787, connect with URL http://localhost:8787/exec, key "dev"
// Drafts the fake backend made are at /fake-gmail, and the newest one renders at /fake-gmail/last.
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

const backend = createBackend({ log: m => console.log(m) });
backend.props.set('API_KEY', 'dev');

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

  if (url.pathname === '/fake-gmail') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ drafts: backend.drafts, sent: backend.sent },
      (k, v) => (k === 'attachments' ? v.map(a => a.getName()) : v), 2));
    return;
  }

  if (url.pathname === '/fake-gmail/last') {
    const draft = backend.drafts.concat(backend.sent).pop();
    if (!draft) { res.writeHead(404); res.end('Nothing drafted or sent yet'); return; }
    // The fake "PDF" is the invoice HTML, which is what the real PDF is rendered from.
    const html = draft.options.htmlBody || draft.options.attachments[0].getDataAsString();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<title>${draft.subject}</title><body style="font:14px sans-serif;padding:16px">` +
      `<p style="color:#666">To: ${draft.to}<br>Subject: ${draft.subject}</p><hr>${html}`);
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
  console.log(`In Settings use URL http://localhost:${PORT}/exec and key "dev". Drafts: /fake-gmail`);
});
