// Minimal static server for verifying the PC leg over http:// - the page refuses file:// by design.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const ROOT = resolve('../dist');
const PORT = 8731;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.task': 'application/octet-stream',
  '.tflite': 'application/octet-stream', '.json': 'application/json', '.css': 'text/css',
};

createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const rel = resolve(join(ROOT, url === '/' ? 'index.html' : url));
  // resolve() puts Windows backslashes in both sides, so the prefix test compares like with like.
  if (rel !== ROOT && !rel.startsWith(ROOT + sep)) { res.writeHead(403).end('no'); return; }
  try {
    const buf = await readFile(rel);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(rel)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 ' + e.code);
  }
}).listen(PORT, '127.0.0.1', () => console.log('serving ' + ROOT + ' on http://localhost:' + PORT));
