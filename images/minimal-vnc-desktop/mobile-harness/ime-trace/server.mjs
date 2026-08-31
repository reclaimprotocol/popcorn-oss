// server.mjs — serves recorder.html and collects the events it posts.
// GET /            recorder page
// POST /ev         one event (the page fires these as they happen)
// GET  /dump       everything recorded since the last reset, as JSON
// POST /reset      clear the buffer
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8731);
let events = [];

createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'POST' && url === '/ev') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { events.push(JSON.parse(body)); } catch (_) {}
      res.writeHead(204).end();
    });
    return;
  }
  if (req.method === 'POST' && url === '/reset') { events = []; res.writeHead(204).end(); return; }
  if (url === '/dump') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(events, null, 1));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(readFileSync(join(here, 'recorder.html')));
}).listen(PORT, () => console.log('ime-trace on :' + PORT));
