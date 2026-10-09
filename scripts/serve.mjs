import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { calendarResponse } from './calendar-feed.mjs';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const port = Number(process.env.PORT || 8000);
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/calendar/pass.ics') {
      const response = calendarResponse(new Request(url, { method: req.method }));
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const path = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html';
    if (!/^(index\.html|encode\.html|sw\.js|sw-assets\.js|manifest\.webmanifest|(?:js|css|icons|asset\/fonts|LICENSES)\/.+)$/.test(path)) throw new Error('not found');
    const file = await realpath(resolve(root, path)), rel = relative(root, file);
    if (rel.startsWith('..') || isAbsolute(rel) || rel.split(/[\\/]/).some(part => part.startsWith('.'))) throw new Error('invalid path');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (_) { res.writeHead(404); res.end('Not found'); }
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Awesome SSTV: http://localhost:${port}/ (calendar subscription enabled)`));
