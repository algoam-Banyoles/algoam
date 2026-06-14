// UI per reproduir un VOD i aplicar-hi el reconeixement del marcador sobre la
// marxa, amb correccions en temps real. El <video> reprodueix l'mp4 local
// (servit amb suport de Range); cada pocs segons la pàgina demana l'OCR del
// frame del temps actual i el servidor l'extreu amb ffmpeg + read_scoreboard.
//   node scripts/train_vod.js   →  http://localhost:8790
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { readScoreboard, closeWorker } = require('./read_scoreboard');

const ROOT = path.join(__dirname, '..', 'train');
const VODDIR = path.join(ROOT, 'vod');
const CORR = path.join(ROOT, 'vod_labels.json');
const HTML = path.join(__dirname, 'train_vod.html');
const PORT = process.env.PORT || 8790;
// Desfàs del tros descarregat respecte al VOD original (s'hi va baixar 600-2400).
const OFFSET = parseInt(process.env.VOD_OFFSET || '600', 10);

function videoFile() {
  const f = fs.existsSync(VODDIR) ? fs.readdirSync(VODDIR).find((x) => /^match\.(mp4|mkv|webm)$/.test(x)) : null;
  return f ? path.join(VODDIR, f) : null;
}
const loadJSON = (p, def) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } };

let busy = false; // el worker de tesseract no és concurrent: serialitzem l'OCR

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const VIDEO = videoFile();

  if (req.method === 'GET' && u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(HTML));
  }

  // Estat de la descàrrega + metadades.
  if (req.method === 'GET' && u.pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ready: !!VIDEO, offset: OFFSET, corrections: Object.keys(loadJSON(CORR, {})).length }));
  }

  // Vídeo amb suport de Range (imprescindible per a poder cercar al <video>).
  if (req.method === 'GET' && u.pathname === '/video') {
    if (!VIDEO) { res.writeHead(404); return res.end('encara descarregant'); }
    const stat = fs.statSync(VIDEO);
    const range = req.headers.range;
    if (range) {
      const m = range.match(/bytes=(\d+)-(\d*)/);
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'video/mp4',
      });
      return fs.createReadStream(VIDEO, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(VIDEO).pipe(res);
  }

  // OCR del frame al temps t (segons, relatius al tros local).
  if (req.method === 'GET' && u.pathname === '/api/ocr') {
    if (!VIDEO) { res.writeHead(503); return res.end('{}'); }
    if (busy) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ busy: true })); }
    busy = true;
    const t = parseFloat(u.searchParams.get('t') || '0');
    const out = path.join(os.tmpdir(), `vodocr_${process.pid}.png`);
    try {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(t), '-i', VIDEO, '-frames:v', '1', '-q:v', '2', out], { timeout: 30000 });
      const r = await readScoreboard(out);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ t, ...r }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ t, found: false, error: e.message }));
    } finally { busy = false; }
    return;
  }

  // Desa una correcció a un moment concret.
  if (req.method === 'POST' && u.pathname === '/api/correct') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { t, label } = JSON.parse(body);
        const all = loadJSON(CORR, {});
        all[(OFFSET + Math.round(t))] = { ...label, t_clip: Math.round(t), t_vod: OFFSET + Math.round(t) };
        fs.writeFileSync(CORR, JSON.stringify(all, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, n: Object.keys(all).length }));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });
    return;
  }

  res.writeHead(404); res.end('no');
});

server.listen(PORT, () => {
  console.log(`\n  UI VOD + OCR en viu  →  http://localhost:${PORT}`);
  console.log(`  vídeo:  ${videoFile() || '(encara descarregant…)'}`);
  console.log(`  correccions: ${CORR}\n  (Ctrl+C per aturar)\n`);
});
process.on('SIGINT', async () => { await closeWorker(); process.exit(0); });
