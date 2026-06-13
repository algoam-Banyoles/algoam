// Lector del marcador (overlay carombooks) d'un fotograma d'un open de billar,
// AMB AUTO-LOCALITZACIÓ (independent de la posició/càmera/tema).
//
// Estratègia:
//  1) Escaneja 4 cantonades: crop generós + escala de grisos + llindar + 2x.
//  2) OCR de cada cantonada amb caixes de paraules (tesseract.js v7 → cal
//     l'opció {blocks:true}, si no `data.words` ve buit).
//  3) Les CARAMBOLES són els DOS números més alts, de costat (mateixa alçada,
//     un a l'esquerra i un a la dreta). La cantonada amb la parella més alta és
//     el marcador. Les entrades = número menor entre els dos.
//  4) Re-OCR AJUSTAT de cada número gran (whitelist de dígits, alta resolució)
//     per fiabilitat — sobretot per distingir 0/6/9.
//
//   CLI:    node scripts/read_scoreboard.js <imatge> [--debug]
//   Mòdul:  const { readScoreboard } = require('./read_scoreboard');
//
const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createWorker } = require('tesseract.js');

const CORNERS = {
  BR: { x: 0.50, y: 0.62, w: 0.50, h: 0.38 },
  BL: { x: 0.00, y: 0.62, w: 0.50, h: 0.38 },
  TR: { x: 0.50, y: 0.00, w: 0.50, h: 0.34 },
  TL: { x: 0.00, y: 0.00, w: 0.50, h: 0.34 },
};
const SCALE = 2; // ampliació del crop de cantonada

function ffSize(img) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', img], { encoding: 'utf8' });
  const m = (r.stdout || '').trim().match(/(\d+)x(\d+)/);
  return m ? { w: +m[1], h: +m[2] } : { w: 1280, h: 720 };
}

function cropCorner(img, frac, size, out) {
  const x = Math.round(frac.x * size.w), y = Math.round(frac.y * size.h);
  const w = Math.round(frac.w * size.w), h = Math.round(frac.h * size.h);
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', img, '-vf',
    `crop=${w}:${h}:${x}:${y},format=gray,lut=y='if(gt(val,150),255,0)',scale=iw*${SCALE}:ih*${SCALE}`, out]);
  return { x, y, w, h };
}

async function ocrWords(worker, img) {
  const { data } = await worker.recognize(img, {}, { blocks: true });
  let words = data.words || [];
  if (!words.length && data.blocks) {
    words = data.blocks.flatMap((b) => (b.paragraphs || []).flatMap((p) => (p.lines || []).flatMap((l) => l.words || [])));
  }
  return words
    .filter((w) => w.text && w.text.trim())
    .map((w) => ({ text: w.text.trim(), conf: w.confidence, b: w.bbox, h: w.bbox.y1 - w.bbox.y0, cx: (w.bbox.x0 + w.bbox.x1) / 2, cy: (w.bbox.y0 + w.bbox.y1) / 2 }));
}

// Parella de caramboles d'una cantonada: dos números d'alçada SIMILAR, de costat
// (mateixa fila), idealment amb un NOM a sobre. Retorna també una puntuació per
// triar la cantonada correcta i descartar soroll.
function scorePair(words) {
  const nums = words
    .map((w) => ({ ...w, v: (w.text.match(/\d+/) || [''])[0] }))
    .filter((w) => w.v && w.v.length <= 3 && w.h >= 25); // descarta soroll petit
  const names = words.filter((w) => /[A-Za-zÀ-ÿ]{3,}/.test(w.text) && w.h >= 12);
  if (nums.length < 2) return null;
  nums.sort((a, b) => b.h - a.h);

  let best = null;
  for (let i = 0; i < nums.length; i++) {
    const big = nums[i];
    const partner = nums.find((n, j) => j !== i
      && Math.abs(n.cy - big.cy) < big.h * 0.5          // mateixa fila
      && Math.abs(n.h - big.h) < big.h * 0.45           // alçada similar (mateixa font)
      && Math.abs(n.cx - big.cx) > big.h * 0.8);        // separats, a banda i banda
    if (!partner) continue;
    const left = big.cx <= partner.cx ? big : partner;
    const right = big.cx <= partner.cx ? partner : big;
    // Hi ha un nom (text) a sobre, entre les dues columnes? Valida que és un marcador.
    const nameAbove = names.some((t) => t.cy < Math.min(left.cy, right.cy)
      && t.cx > left.cx - left.h && t.cx < right.cx + right.h);
    const minH = Math.min(left.h, right.h);
    const ent = nums.find((n) => n !== left && n !== right
      && n.cx > left.cx && n.cx < right.cx && n.h < minH * 0.8
      && n.cy >= Math.min(left.cy, right.cy) - minH * 0.3);
    const score = (left.h + right.h) * (nameAbove ? 1.6 : 1);
    if (!best || score > best.score) best = { left, right, ent, score, nameAbove };
  }
  return best;
}

// Re-OCR ajustat d'un número (caixa en coords del crop-2x) sobre el frame
// original, en alta resolució i amb whitelist de dígits (precisió 0/6/9).
async function refineDigit(worker, img, frac, size, box, tmp, tag) {
  const sx = frac.x * size.w, sy = frac.y * size.h;
  const pad = 4;
  const ox = Math.max(0, Math.round(sx + box.x0 / SCALE) - pad);
  const oy = Math.max(0, Math.round(sy + box.y0 / SCALE) - pad);
  const ow = Math.round((box.x1 - box.x0) / SCALE) + pad * 2;
  const oh = Math.round((box.y1 - box.y0) / SCALE) + pad * 2;
  const out = path.join(tmp, `d_${tag}.png`);
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', img, '-vf',
    `crop=${ow}:${oh}:${ox}:${oy},format=gray,lut=y='if(gt(val,160),255,0)',scale=iw*4:ih*4`, out]);
  await worker.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '7' });
  const { data } = await worker.recognize(out);
  await worker.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: '11' });
  const m = (data.text || '').match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

async function readScoreboard(img, { debug = false } = {}) {
  const size = ffSize(img);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb_'));
  const worker = await createWorker('eng');
  await worker.setParameters({ tessedit_pageseg_mode: '11' });

  let best = null;
  for (const [name, frac] of Object.entries(CORNERS)) {
    const out = path.join(tmp, `${name}.png`);
    cropCorner(img, frac, size, out);
    const words = await ocrWords(worker, out);
    const pair = scorePair(words);
    if (debug) console.error(`${name}: words=${words.length} pair=${pair ? pair.pairHeight : '-'}`);
    if (debug && pair) console.error(`   ${name} pair: ${pair.left.text}/${pair.right.text} score=${Math.round(pair.score)} name=${pair.nameAbove}`);
    if (pair && (!best || pair.score > best.pair.score)) best = { name, frac, pair, words };
  }

  if (!best) { await worker.terminate(); return { found: false, state: 'no_scoreboard' }; }

  // Re-OCR ajustat dels dos números grans (precisió 0/6/9). Si falla o dóna un
  // resultat menys fiable, ens quedem amb la lectura de cantonada.
  const { frac, pair } = best;
  const looseL = parseInt((pair.left.text.match(/\d+/) || ['0'])[0], 10);
  const looseR = parseInt((pair.right.text.match(/\d+/) || ['0'])[0], 10);
  const refL = await refineDigit(worker, img, frac, size, pair.left.b, tmp, 'L');
  const refR = await refineDigit(worker, img, frac, size, pair.right.b, tmp, 'R');
  await worker.terminate();

  // Confia en el re-OCR només si coincideix en nombre de dígits amb la lectura
  // de cantonada (evita regressions com 20→0); si no, fes servir la cantonada.
  const pick = (loose, ref) => (ref != null && String(ref).length === String(loose).length ? ref : loose);

  return {
    found: true,
    corner: best.name,
    car_left: pick(looseL, refL),
    car_right: pick(looseR, refR),
    entrades: pair.ent ? parseInt((pair.ent.text.match(/\d+/) || [''])[0], 10) : null,
  };
}

module.exports = { readScoreboard };

if (require.main === module) {
  const img = process.argv[2];
  const debug = process.argv.includes('--debug');
  if (!img) { console.error('ús: node scripts/read_scoreboard.js <imatge> [--debug]'); process.exit(1); }
  readScoreboard(img, { debug }).then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error('ERR', e.message); process.exit(1); });
}
