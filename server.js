// Local static server + admin API (no key needed). Run with: node server.js  (or npm run serve)
// On Vercel the same API is served by api/*.js backed by Blob storage.
//   POST /api/save            body: JSON tree      -> writes content.json
//   POST /api/upload?name=x   body: image bytes    -> writes images/<name>, returns { path }
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.txt': 'text/plain' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function send(res, status, body, type = 'text/plain') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'POST' && url.pathname === '/api/save') {
      const tree = JSON.parse((await readBody(req)).toString('utf8'));
      if (!tree || typeof tree.id !== 'string') return send(res, 400, 'bad tree');
      fs.writeFileSync(path.join(ROOT, 'content.json'), JSON.stringify(tree, null, 2) + '\n');
      return send(res, 200, '{"ok":true}', 'application/json');
    }
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const raw = (url.searchParams.get('name') || 'image').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
      const ext = path.extname(raw) || '.jpg';
      const base = path.basename(raw, ext) || 'image';
      let name = base + ext, i = 2;
      while (fs.existsSync(path.join(ROOT, 'images', name))) name = `${base}-${i++}${ext}`;
      fs.mkdirSync(path.join(ROOT, 'images'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'images', name), await readBody(req));
      return send(res, 200, JSON.stringify({ path: 'images/' + name }), 'application/json');
    }
    if (req.method === 'GET' && url.pathname === '/api/content') {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'content.json')), 'application/json');
    }
    if (req.method !== 'GET') return send(res, 405, 'method not allowed');
    let file = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (file === '/' || file === '\\') file = '/index.html';
    const abs = path.join(ROOT, file);
    if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return send(res, 404, 'not found');
    send(res, 200, fs.readFileSync(abs), MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
  } catch (e) {
    send(res, 500, String(e.message || e));
  }
}).listen(PORT, () => console.log(`The Map: http://localhost:${PORT}`));
