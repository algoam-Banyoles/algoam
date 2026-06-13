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

// Llindars de binarització per a l'escaneig de cantonades. Un sol llindar trenca
// alguns dígits (p.ex. el "5" a 150 → "="); diferents llindars capturen dígits
// diferents, així que escanegem amb tots i AGRUPEM les paraules abans de buscar
// la parella. Robust davant temes/càmeres diferents.
const SCAN_THRESHOLDS = (process.env.SB_THRS || '110,135,165').split(',').map(Number);

function cropCorner(img, frac, size, out, thr = 135) {
  const x = Math.round(frac.x * size.w), y = Math.round(frac.y * size.h);
  const w = Math.round(frac.w * size.w), h = Math.round(frac.h * size.h);
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', img, '-vf',
    `crop=${w}:${h}:${x}:${y},format=gray,lut=y='if(gt(val,${thr}),255,0)',scale=iw*${SCALE}:ih*${SCALE}`, out]);
  return { x, y, w, h };
}

// Fracció de píxels vermells a la regió (per detectar el rellotge vermell de
// l'escalfament / mitja part / pausa, que corromp les lectures). Llegeix RGB
// cru d'un crop reduït via ffmpeg (sense geq, sense problemes d'escapat).
function redFraction(img, frac, size) {
  const x = Math.round(frac.x * size.w), y = Math.round(frac.y * size.h);
  const w = Math.round(frac.w * size.w), h = Math.round(frac.h * size.h);
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', img, '-vf',
    `crop=${w}:${h}:${x}:${y},scale=80:80,format=rgb24`, '-f', 'rawvideo', '-'],
    { maxBuffer: 1 << 22 });
  const buf = r.stdout;
  if (!buf || buf.length < 3) return 0;
  let red = 0;
  for (let i = 0; i + 2 < buf.length; i += 3) {
    if (buf[i] > 140 && buf[i + 1] < 95 && buf[i + 2] < 95) red++;
  }
  return red / (buf.length / 3);
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

// En agrupar paraules de diversos llindars, un mateix dígit hi surt diverses
// vegades (a posicions gairebé idèntiques) amb lectures possiblement diferents
// (p.ex. el "6" net i un "2" trencat al mateix lloc). Ens quedem, per cada
// agrupació de posició, la lectura de MÉS CONFIANÇA — així el soroll d'un llindar
// dolent no guanya pel sol fet de ser més alt.
function dedupeWords(words) {
  // Per posició ens quedem la lectura de MÉS confiança (el soroll d'un llindar
  // dolent no guanya pel sol fet de ser més alt). El valor final de cada número
  // NO surt d'aquí sinó del re-OCR amb vot (refineDigit), que és més fiable.
  const sorted = [...words].sort((a, b) => b.conf - a.conf);
  const kept = [];
  for (const w of sorted) {
    if (!kept.some((k) => Math.abs(k.cx - w.cx) < Math.max(k.h, w.h) * 0.7 && Math.abs(k.cy - w.cy) < w.h * 0.7)) {
      kept.push(w);
    }
  }
  return kept;
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
    // Entrades: número ENTRE les dues caramboles, més petit, i a la MATEIXA
    // alçada (el més proper al centre vertical de les caramboles).
    const midY = (left.cy + right.cy) / 2;
    // Entrades = el número del mig a la MATEIXA FILA que les caramboles (no el
    // rellotge de tacada, que va a sobre amb els noms). Pot ser tan alt com les
    // caramboles, així que NO el filtrem per alçada màxima; només descartem
    // soroll petit i exigim que estigui a tocar de la fila de caramboles.
    const entCands = nums.filter((n) => n !== left && n !== right
      && n.cx > left.cx && n.cx < right.cx
      && Math.abs(n.cy - midY) < minH * 0.9
      && n.h >= minH * 0.25);
    entCands.sort((a, b) => Math.abs(a.cy - midY) - Math.abs(b.cy - midY));
    let ent = entCands[0] || null;
    if (ent) {
      // Fusiona els dígits del MATEIX número d'entrades quan l'OCR els ha
      // segmentat (p.ex. "2"+"0" → "20"): els que són a la mateixa fila que
      // l'entrada triada. Caixa = unió; text = dígits en ordre d'esquerra a dreta.
      const sameRow = entCands.filter((n) => Math.abs(n.cy - ent.cy) < ent.h * 0.6);
      if (sameRow.length > 1) {
        sameRow.sort((a, b) => a.cx - b.cx);
        const bb = {
          x0: Math.min(...sameRow.map((n) => n.b.x0)),
          y0: Math.min(...sameRow.map((n) => n.b.y0)),
          x1: Math.max(...sameRow.map((n) => n.b.x1)),
          y1: Math.max(...sameRow.map((n) => n.b.y1)),
        };
        ent = { ...ent, b: bb, text: sameRow.map((n) => n.v).join(''), h: bb.y1 - bb.y0, cx: (bb.x0 + bb.x1) / 2, cy: (bb.y0 + bb.y1) / 2 };
      }
    }
    // Nom de cada jugador: en carombooks l'ordre vertical és [CLUB]/[JUGADOR]/
    // [NÚMERO], així que agafem el text a sobre del número, del costat correcte
    // (més a prop d'aquesta columna que de l'altra) i el MÉS BAIX (més a prop del
    // número = el jugador, no el club que té a sobre).
    const nearName = (col, other) => {
      const cand = names.filter((t) => t.cy < col.cy
        && Math.abs(t.cx - col.cx) < col.h * 2.2
        && Math.abs(t.cx - col.cx) <= Math.abs(t.cx - other.cx));
      if (!cand.length) return null;
      cand.sort((a, b) => b.cy - a.cy);
      return cand[0].text;
    };
    const score = (left.h + right.h) * (nameAbove ? 1.6 : 1);
    if (!best || score > best.score) best = { left, right, ent, score, nameAbove, name_left: nearName(left, right), name_right: nearName(right, left) };
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
  // Diverses combinacions (llindar × segmentació) i VOT majoritari: un dígit es
  // pot trencar amb un llindar concret (p.ex. 8→3, 6→5), però rarament amb tots.
  const votes = [];
  const configs = [[150, '7'], [185, '8'], [120, '7']];
  for (let i = 0; i < configs.length; i++) {
    const [thr, psm] = configs[i];
    const out = path.join(tmp, `d_${tag}_${i}.png`);
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', img, '-vf',
      `crop=${ow}:${oh}:${ox}:${oy},format=gray,lut=y='if(gt(val,${thr}),255,0)',scale=iw*4:ih*4`, out]);
    await worker.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: psm });
    const { data } = await worker.recognize(out);
    const m = (data.text || '').replace(/\s+/g, '').match(/^\d{1,3}/);
    if (m) votes.push(m[0]);
  }
  await worker.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: '11' });
  if (!votes.length) return null;
  const c = {};
  for (const v of votes) c[v] = (c[v] || 0) + 1;
  return parseInt(Object.entries(c).sort((a, b) => b[1] - a[1])[0][0], 10);
}

// Worker de tesseract persistent (reutilitzat entre crides — evita re-inicialitzar
// a cada fotograma, molt més ràpid quan el worker processa molts frames).
let _worker = null;
async function getWorker() {
  if (!_worker) {
    _worker = await createWorker('eng');
    await _worker.setParameters({ tessedit_pageseg_mode: '11' });
  }
  return _worker;
}

async function readScoreboard(img, { debug = false, returnBoxes = false } = {}) {
  const size = ffSize(img);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb_'));
  const worker = await getWorker();
  await worker.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: '11' });

  let best = null;
  for (const [name, frac] of Object.entries(CORNERS)) {
    // Escaneja amb diversos llindars i AGRUPA les paraules: un dígit que es trenca
    // amb un llindar concret sol llegir-se bé amb un altre. scorePair ignora els
    // duplicats a la mateixa posició (exigeix separació esquerra-dreta).
    let words = [];
    for (const thr of SCAN_THRESHOLDS) {
      const out = path.join(tmp, `${name}_${thr}.png`);
      cropCorner(img, frac, size, out, thr);
      words = words.concat(await ocrWords(worker, out));
    }
    words = dedupeWords(words);
    const pair = scorePair(words);
    if (debug) console.error(`${name}: words=${words.length}${pair ? ` pair ${pair.left.text}/${pair.right.text} ent=${pair.ent ? pair.ent.text : '-'} score=${Math.round(pair.score)} name=${pair.nameAbove}` : ''}`);
    if (pair && (!best || pair.score > best.pair.score)) best = { name, frac, pair, words };
  }

  if (!best) { fs.rmSync(tmp, { recursive: true, force: true }); return { found: false, state: 'no_scoreboard' }; }

  // Rellotge vermell (escalfament/mitja part/pausa) → no és una lectura fiable.
  // Criteri estricte (R>140,G<95,B<95): rellotges ~0.026+, marcadors nets ≤0.019.
  if (redFraction(img, best.frac, size) > 0.024) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { found: false, state: 'clock' };
  }

  // Re-OCR ajustat dels dos números grans (precisió 0/6/9). Si falla o dóna un
  // resultat menys fiable, ens quedem amb la lectura de cantonada.
  const { frac, pair } = best;
  const looseL = parseInt((pair.left.text.match(/\d+/) || ['0'])[0], 10);
  const looseR = parseInt((pair.right.text.match(/\d+/) || ['0'])[0], 10);
  // Confia en el re-OCR (vot multi-llindar) només si coincideix en nombre de
  // dígits amb la lectura de cantonada (evita regressions com 20→0); si no, la
  // de cantonada. Per a les entrades la caixa ja ve fusionada (tots els dígits).
  const pick = (loose, ref) => (ref != null && String(ref).length === String(loose).length ? ref : loose);
  const refL = await refineDigit(worker, img, frac, size, pair.left.b, tmp, 'L');
  const refR = await refineDigit(worker, img, frac, size, pair.right.b, tmp, 'R');
  let entrades = null;
  if (pair.ent) {
    // Caixa d'entrades per POSICIÓ: centrada horitzontalment entre les dues
    // caramboles, a la fila de l'entrada, prou ampla per a 2-3 dígits. Així
    // capturem el número sencer encara que l'OCR de cantonada n'hagi llegit un
    // sol dígit ("20"→"2"); el valor surt del vot multi-llindar (refineDigit).
    const minH2 = Math.min(pair.left.h, pair.right.h);
    const cxMid = (pair.left.cx + pair.right.cx) / 2;
    const h = Math.max(pair.ent.h, minH2 * 0.5);
    const halfW = h * 0.95;
    const entBox = { x0: cxMid - halfW, y0: pair.ent.cy - h * 0.65, x1: cxMid + halfW, y1: pair.ent.cy + h * 0.65 };
    const refE = await refineDigit(worker, img, frac, size, entBox, tmp, 'E');
    const looseE = parseInt((pair.ent.text.match(/\d+/) || [''])[0], 10);
    entrades = refE != null ? refE : (Number.isNaN(looseE) ? null : looseE);
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  const out = {
    found: true,
    corner: best.name,
    car_left: pick(looseL, refL),
    car_right: pick(looseR, refR),
    entrades: entrades ?? null,
    name_left: pair.name_left || null,
    name_right: pair.name_right || null,
  };
  if (returnBoxes) {
    // Caixes dels números en coords de la IMATGE ORIGINAL (per extreure glifs).
    const toOrig = (b) => {
      const sx = frac.x * size.w, sy = frac.y * size.h, pad = 4;
      return {
        x: Math.max(0, Math.round(sx + b.x0 / SCALE) - pad),
        y: Math.max(0, Math.round(sy + b.y0 / SCALE) - pad),
        w: Math.round((b.x1 - b.x0) / SCALE) + pad * 2,
        h: Math.round((b.y1 - b.y0) / SCALE) + pad * 2,
      };
    };
    out.boxes = { left: toOrig(pair.left.b), right: toOrig(pair.right.b), ent: pair.ent ? toOrig(pair.ent.b) : null };
  }
  return out;
}

async function closeWorker() { if (_worker) { try { await _worker.terminate(); } catch { /* noop */ } _worker = null; } }

module.exports = { readScoreboard, closeWorker };

if (require.main === module) {
  const img = process.argv[2];
  const debug = process.argv.includes('--debug');
  if (!img) { console.error('ús: node scripts/read_scoreboard.js <imatge> [--debug]'); process.exit(1); }
  readScoreboard(img, { debug })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error('ERR', e.message); })
    .finally(() => closeWorker());
}
