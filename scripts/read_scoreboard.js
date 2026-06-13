// Lector del marcador (overlay carombooks) d'un fotograma d'un open de billar.
// OCR per REGIONS amb tesseract.js; preprocessat amb ffmpeg (gris + llindar) per
// aïllar el text clar sobre fons fosc.
//
// La posició/mida del marcador varia per PRODUCCIÓ (club). Per això les regions
// es defineixen en PRESETS per club, calibrats una vegada des d'un VOD (vegeu la
// recepta a baix). Totes les coordenades són per a un fotograma 1280x720 i
// s'escalen proporcionalment per altres resolucions.
//
//   Ús (CLI):  node scripts/read_scoreboard.js <imatge> [preset] [--debug]
//   Ús (mòdul): const { readScoreboard, PRESETS } = require('./read_scoreboard');
//
// ─── RECEPTA per calibrar un club nou des d'un VOD ──────────────────────────
//  1. Tria un VOD del canal del club amb una partida EN JOC (no escalfament).
//  2. yt-dlp -f 'best[height<=720]' -g <url> | (agafa la url) ;
//     ffmpeg -ss <segons> -i <url> -frames:v 1 frame.jpg   (un instant amb marcador)
//  3. Dibuixa caixes candidates i ajusta-les fins encertar cada camp:
//     ffmpeg -i frame.jpg -vf "drawbox=x=..:y=..:w=..:h=..:color=red:t=2,..." calib.png
//  4. Copia les coordenades (1280x720) a un preset nou aquí sota.
//  5. Valida: node scripts/read_scoreboard.js frame.jpg <preset> --debug
// ────────────────────────────────────────────────────────────────────────────

const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createWorker } = require('tesseract.js');

const REF_W = 1280, REF_H = 720;

// Presets de regions per club (coordenades x,y,w,h a 1280x720).
// 'costa_daurada' (seus Tarragona i Mont-Roig) està validat: llegeix 12·41·20
// i 27·50·27 correctament. Afegeix-ne de nous amb la recepta de dalt.
const PRESETS = {
  costa_daurada: {
    name_left:  { x: 880, y: 551, w: 120, h: 28, kind: 'text' },
    name_right: { x: 1118, y: 551, w: 152, h: 28, kind: 'text' },
    car_left:   { x: 905, y: 590, w: 100, h: 62, kind: 'digits' },
    car_right:  { x: 1148, y: 590, w: 92, h: 62, kind: 'digits' },
    entrades:   { x: 1050, y: 600, w: 56, h: 52, kind: 'digits' },
  },
  // sants:        { ... },  // pendent de calibrar des d'un VOD
  // sant_adria:   { ... },
  // llinars:      { ... },
};

function ffprobeSize(img) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', img], { encoding: 'utf8' });
  const m = (r.stdout || '').trim().match(/(\d+)x(\d+)/);
  return m ? { w: +m[1], h: +m[2] } : { w: REF_W, h: REF_H };
}

function cropRegion(img, reg, size, outPath) {
  const sx = size.w / REF_W, sy = size.h / REF_H;
  const x = Math.round(reg.x * sx), y = Math.round(reg.y * sy);
  const w = Math.round(reg.w * sx), h = Math.round(reg.h * sy);
  const thr = reg.kind === 'digits' ? 165 : 110;
  const vf = `crop=${w}:${h}:${x}:${y},format=gray,lut=y='if(gt(val,${thr}),255,0)',scale=iw*3:ih*3`;
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', img, '-vf', vf, outPath]);
}

async function readScoreboard(img, presetName = 'costa_daurada', { debug = false } = {}) {
  const preset = PRESETS[presetName];
  if (!preset) throw new Error(`preset desconegut: ${presetName} (tens: ${Object.keys(PRESETS).join(', ')})`);
  const size = ffprobeSize(img);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb_'));
  const worker = await createWorker('eng');
  const out = {};
  for (const [key, reg] of Object.entries(preset)) {
    const cropPath = path.join(tmp, `${key}.png`);
    cropRegion(img, reg, size, cropPath);
    if (reg.kind === 'digits') {
      await worker.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '7' });
    } else {
      await worker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZÀÁÉÍÓÚÏÜÇÑ -', tessedit_pageseg_mode: '7' });
    }
    const { data } = await worker.recognize(cropPath);
    out[key] = data.text.replace(/\n/g, ' ').trim();
    if (debug) out[`_${key}_crop`] = cropPath;
  }
  await worker.terminate();
  return out;
}

module.exports = { readScoreboard, PRESETS };

if (require.main === module) {
  const img = process.argv[2];
  const preset = process.argv.find((a, i) => i >= 3 && !a.startsWith('--')) || 'costa_daurada';
  const debug = process.argv.includes('--debug');
  if (!img) { console.error('ús: node scripts/read_scoreboard.js <imatge> [preset] [--debug]'); process.exit(1); }
  readScoreboard(img, preset, { debug })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error('ERR', e.message); process.exit(1); });
}
