// Construeix train/manifest.json: per cada frame de train/frames/, hi desa la
// proposta de l'OCR (read_scoreboard) + el títol de l'stream (font dels noms).
// Ús: node scripts/train_build.js
const fs = require('fs');
const path = require('path');
const { readScoreboard, closeWorker } = require('./read_scoreboard');

const FRAMES = path.join(__dirname, '..', 'train', 'frames');
const MANIFEST = path.join(__dirname, '..', 'train', 'manifest.json');

// Títol de l'stream per prefix de fitxer (d'on surten els noms quan el porta).
const TITLES = {
  tarragona: 'OPEN 3B C. DAURADA PRE-PREVIA  J. MANRESA (C.B.TARRAGONA)  VS  J. BUSQUED (C.B.BORGES)',
  tarrms: 'OPEN 3B C. DAURADA PRE-PREVIA  F. MORENO (C.B.TARRAGONA)  VS  J.N. SALVANY (C.B.BORGES)',
  tarrmm: 'OPEN 3B C. DAURADA PRE-PREVIA  J. MANRESA (C.B.TARRAGONA)  VS  R. MEJIAS (C.B.MONT-ROIG)',
  sants: 'II OPEN SANTS Q47/2 PRÈVIES GRUP N VILALTA - VÍLCHEZ',
  montroig: 'IV OPEN COSTA DAURADA PRE-PRÈVIA TAULA 1',
  montroig2: 'IV OPEN COSTA DAURADA PRE-PRÈVIES TAULA 2',
  santadria: 'CAMPIONAT CATALÀ BIATHLÓ QUARTS Luque-Puig',
  llinars: 'LLIGA CATALANA 4 MODALITATS PROMOCIÓ A HONOR',
};

(async () => {
  const files = fs.readdirSync(FRAMES).filter((f) => f.endsWith('.png')).sort();
  const out = [];
  for (const f of files) {
    const id = f.replace(/\.png$/, '');
    const prefix = id.split('_')[0];
    const img = path.join(FRAMES, f);
    let ocr;
    try { ocr = await readScoreboard(img); }
    catch (e) { ocr = { found: false, error: e.message }; }
    out.push({ id, img: f, title: TITLES[prefix] || '', ocr });
    console.log(id, '->', ocr.found ? `${ocr.car_left}-${ocr.car_right} ent=${ocr.entrades} L='${ocr.name_left}' R='${ocr.name_right}'` : `found=false (${ocr.state || ''})`);
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(out, null, 2));
  console.log('\nmanifest:', MANIFEST, `(${out.length} frames)`);
  await closeWorker();
})();
