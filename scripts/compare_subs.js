const fs = require('fs');
const path = require('path');

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('usage: node compare_subs.js <subscripcions.csv>');
  process.exit(1);
}

// El CSV de Takeout pot venir amb UTF-8 mal interpretat (mojibake). Llegim
// com a binari i provem fer fix Latin1->UTF-8 si detectem la signatura mojibake.
let raw = fs.readFileSync(csvPath, 'utf8');
if (raw.includes('Ã') || raw.includes('Â')) {
  // mojibake: el fitxer és UTF-8 ja correcte llegit com a UTF-8, però el creador
  // el va escriure amb double-encoding. Re-interpretem.
  raw = Buffer.from(raw, 'latin1').toString('utf8');
}

const lines = raw.split(/\r?\n/).filter(Boolean);
lines.shift(); // header

const csvChannels = lines.map(line => {
  // CSV simple sense cometes complexes
  const [id, url, ...rest] = line.split(',');
  const title = rest.join(',').trim();
  return { id: id.trim(), title };
});

const canals = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'canals.json'), 'utf8'));
const existingIds = new Set(canals.map(c => c.channelId));

const missing = csvChannels.filter(c => !existingIds.has(c.id));
console.log(`Total subscripcions: ${csvChannels.length}`);
console.log(`Ja a canals.json: ${csvChannels.length - missing.length}`);
console.log(`Noves: ${missing.length}\n`);

console.log('=== CHANNELS NO PRESENTS A canals.json ===');
for (const c of missing) {
  console.log(`${c.id} | ${c.title}`);
}
