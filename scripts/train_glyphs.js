// Construeix un classificador de dígits PER FORMA (plantilles) per a la font
// carombooks, que tesseract confon (2↔7, 7↔4, 0↔1...). Extreu glifs etiquetats
// de la veritat de terreny (train/labels.json sobre train/frames + vod_labels.json
// sobre el VOD local), normalitza cada dígit a una graella binària i en fa la
// mitjana per dígit → train/digit_templates.json. Mesura amb leave-one-out.
//   node scripts/train_glyphs.js
const { readScoreboard, closeWorker } = require('./read_scoreboard');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const W = 16, H = 24, THR = 140;

function glyphVec(img, x, y, w, h) {
  try {
    const r = execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', img, '-vf',
      `crop=${Math.max(1, Math.round(w))}:${Math.max(1, Math.round(h))}:${Math.max(0, Math.round(x))}:${Math.max(0, Math.round(y))},format=gray,lut=y='if(gt(val,${THR}),255,0)',scale=${W}:${H}`,
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 20 });
    const v = new Uint8Array(W * H);
    for (let i = 0; i < W * H && i < r.length; i++) v[i] = r[i] > 127 ? 1 : 0;
    return v;
  } catch { return null; }
}

// Extreu els glifs (un per dígit) d'un número situat a `box`, partint la caixa
// en N columnes iguals (N = nombre de dígits de la veritat).
function extractDigits(img, box, valueStr, srcId, tag, samples) {
  const n = valueStr.length;
  if (!box || n === 0) return;
  for (let i = 0; i < n; i++) {
    const subw = box.w / n;
    const v = glyphVec(img, box.x + i * subw, box.y, subw, box.h);
    if (v) samples.push({ digit: valueStr[i], vec: v, src: `${srcId}:${tag}${i}` });
  }
}

async function collect(frameImg, gt, srcId, samples) {
  // gt: {car_left, car_right, entrades} com a strings (veritat)
  const r = await readScoreboard(frameImg, { returnBoxes: true });
  if (!r.found || !r.boxes) return false;
  if (gt.car_left !== '' && gt.car_left != null) extractDigits(frameImg, r.boxes.left, String(gt.car_left), srcId, 'L', samples);
  if (gt.car_right !== '' && gt.car_right != null) extractDigits(frameImg, r.boxes.right, String(gt.car_right), srcId, 'R', samples);
  if (gt.entrades !== '' && gt.entrades != null && r.boxes.ent) extractDigits(frameImg, r.boxes.ent, String(gt.entrades), srcId, 'E', samples);
  return true;
}

function buildTemplates(samples) {
  const acc = {};
  for (const s of samples) {
    if (!acc[s.digit]) acc[s.digit] = { sum: new Float32Array(W * H), n: 0 };
    for (let i = 0; i < W * H; i++) acc[s.digit].sum[i] += s.vec[i];
    acc[s.digit].n++;
  }
  const tmpl = {};
  for (const d of Object.keys(acc)) {
    tmpl[d] = Array.from(acc[d].sum, (x) => x / acc[d].n);
  }
  return tmpl;
}

function classify(vec, tmpl, exclude) {
  let best = null, bestScore = -1;
  for (const d of Object.keys(tmpl)) {
    if (d === exclude) { /* permès: és per dígit, no per mostra */ }
    const t = tmpl[d];
    let s = 0;
    for (let i = 0; i < W * H; i++) s += vec[i] ? t[i] : (1 - t[i]);
    s /= (W * H);
    if (s > bestScore) { bestScore = s; best = d; }
  }
  return { digit: best, score: bestScore };
}

(async () => {
  const ROOT = path.join(__dirname, '..', 'train');
  const samples = [];

  // 1) Calibració: train/frames + labels.json
  const labels = JSON.parse(fs.readFileSync(path.join(ROOT, 'labels.json'), 'utf8'));
  let okC = 0, totC = 0;
  for (const id of Object.keys(labels)) {
    const t = labels[id];
    if (t.no_scoreboard) continue;
    totC++;
    const img = path.join(ROOT, 'frames', id + '.png');
    if (fs.existsSync(img) && await collect(img, t, id, samples)) okC++;
  }

  // 2) VOD: vod_labels.json sobre match.mp4 (extraient cada frame)
  const vodFile = path.join(ROOT, 'vod', 'match.mp4');
  let okV = 0, totV = 0;
  if (fs.existsSync(vodFile)) {
    const vlab = JSON.parse(fs.readFileSync(path.join(ROOT, 'vod_labels.json'), 'utf8'));
    for (const k of Object.keys(vlab)) {
      const t = vlab[k];
      if (t.no_scoreboard) continue;
      totV++;
      const out = path.join(os.tmpdir(), 'gl_' + k + '.png');
      try {
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(t.t_clip), '-i', vodFile, '-frames:v', '1', '-q:v', '2', out], { timeout: 30000 });
        if (await collect(out, t, 'vod' + k, samples)) okV++;
        fs.unlinkSync(out);
      } catch { /* skip */ }
    }
  }

  // Recompte per dígit
  const counts = {};
  for (const s of samples) counts[s.digit] = (counts[s.digit] || 0) + 1;
  console.log(`frames calibració ${okC}/${totC}, VOD ${okV}/${totV} → ${samples.length} glifs`);
  console.log('per dígit:', Object.keys(counts).sort().map((d) => `${d}:${counts[d]}`).join('  '));

  // Plantilles (totes les mostres) + desa
  const tmpl = buildTemplates(samples);
  fs.writeFileSync(path.join(ROOT, 'digit_templates.json'), JSON.stringify({ W, H, THR, tmpl }));

  // Leave-one-out per mostra (plantilles sense la mostra)
  let correct = 0;
  const conf = {}; // veritat→{predicció:n}
  for (let i = 0; i < samples.length; i++) {
    const tmplLoo = buildTemplates(samples.filter((_, j) => j !== i));
    const { digit } = classify(samples[i].vec, tmplLoo);
    const gt = samples[i].digit;
    if (digit === gt) correct++;
    conf[gt] = conf[gt] || {};
    conf[gt][digit] = (conf[gt][digit] || 0) + 1;
  }
  console.log(`\nLOO classificador de forma: ${correct}/${samples.length} (${(100 * correct / samples.length).toFixed(0)}%)`);
  for (const d of Object.keys(conf).sort()) {
    const preds = Object.entries(conf[d]).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p}×${n}`).join(' ');
    console.log(`  ${d} → ${preds}`);
  }
  await closeWorker();
})();
