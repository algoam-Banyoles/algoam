// Servidor local per validar/corregir les lectures de l'OCR frame a frame.
// Serveix els frames + la proposta de l'OCR (manifest.json) i desa la veritat de
// terreny a train/labels.json. Sense dependències (només http/fs).
//   node scripts/train_ui.js   →  http://localhost:8787
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'train');
const FRAMES = path.join(ROOT, 'frames');
const MANIFEST = path.join(ROOT, 'manifest.json');
const LABELS = path.join(ROOT, 'labels.json');
const HTML = path.join(__dirname, 'train_ui.html');
const PORT = process.env.PORT || 8787;

const loadJSON = (p, def) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(HTML));
  }
  if (req.method === 'GET' && u.pathname === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ manifest: loadJSON(MANIFEST, []), labels: loadJSON(LABELS, {}) }));
  }
  if (req.method === 'GET' && u.pathname.startsWith('/frames/')) {
    const f = path.join(FRAMES, path.basename(decodeURIComponent(u.pathname.slice(8))));
    if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(fs.readFileSync(f)); }
    res.writeHead(404); return res.end('no');
  }
  if (req.method === 'POST' && u.pathname === '/api/label') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { id, label } = JSON.parse(body);
        const labels = loadJSON(LABELS, {});
        labels[id] = label;
        fs.writeFileSync(LABELS, JSON.stringify(labels, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, n: Object.keys(labels).length }));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });
    return;
  }
  res.writeHead(404); res.end('no');
});

server.listen(PORT, () => {
  console.log(`\n  UI d'entrenament OCR  →  http://localhost:${PORT}\n`);
  console.log(`  frames:  ${FRAMES}`);
  console.log(`  veritat: ${LABELS}\n  (Ctrl+C per aturar)\n`);
});
