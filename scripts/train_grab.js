// Descarrega frames de VODs (streams passats) dels canals d'opens cap a
// train/frames/<key>_<ts>.png (salta els que ja hi són). Després passa-hi
// train_build.js per generar el manifest amb les propostes de l'OCR.
//   node scripts/train_grab.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const FRAMES = path.join(__dirname, '..', 'train', 'frames');
fs.mkdirSync(FRAMES, { recursive: true });

// key = prefix del fitxer (ha de coincidir amb el mapa TITLES de train_build.js).
const VIDEOS = [
  { key: 'tarragona', id: '5ILaNvSQdyY', tss: [1000, 2000, 2800, 3500, 4000, 4700] }, // MANRESA-BUSQUET
  { key: 'tarrms', id: '9SfoKX0F7mU', tss: [700, 1500, 2300, 3100, 3900, 4700] },     // MORENO-SALVANY
  { key: 'tarrmm', id: 'obGuzf5_WJQ', tss: [700, 1600, 2500, 3400, 4300, 5200] },     // MANRESA-MEJIAS
  { key: 'sants', id: '_N8YNacsj1Q', tss: [800, 2200, 2800, 4200, 5000, 5800] },      // VILALTA-VÍLCHEZ
];

function grab(id, ts, out, fmt = '95/94/93/best') {
  if (fs.existsSync(out)) return 'skip';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g_'));
  try {
    execFileSync('yt-dlp', ['-f', fmt, '--download-sections', `*${ts}-${ts + 4}`, '-q',
      '-o', path.join(tmp, 'c.%(ext)s'), `https://www.youtube.com/watch?v=${id}`],
      { stdio: 'ignore', timeout: 120000 });
    const files = fs.readdirSync(tmp);
    if (!files.length) return 'fail';
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '2', '-i', path.join(tmp, files[0]),
      '-frames:v', '1', '-q:v', '2', out], { timeout: 40000 });
    return fs.existsSync(out) ? 'ok' : 'fail';
  } catch { return 'fail'; }
  finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } }
}

let ok = 0, fail = 0, skip = 0;
for (const v of VIDEOS) {
  for (const ts of v.tss) {
    const out = path.join(FRAMES, `${v.key}_${ts}.png`);
    const r = grab(v.id, ts, out);
    if (r === 'ok') ok++; else if (r === 'skip') skip++; else fail++;
    console.log(`${v.key}_${ts}: ${r}`);
  }
}
console.log(`\nok=${ok} skip=${skip} fail=${fail}  → ara: node scripts/train_build.js`);
