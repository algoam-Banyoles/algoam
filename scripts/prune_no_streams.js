// Esborra els channelIds passats per argv de canals.json. Imprimeix el
// nom de cadascun esborrat per facilitar la verificació.

const fs = require('fs');
const path = require('path');

const idsToRemove = new Set(process.argv.slice(2));
if (idsToRemove.size === 0) {
  console.error('usage: node prune_no_streams.js <channelId>...');
  process.exit(1);
}

const canalsPath = path.join(__dirname, '..', 'canals.json');
const canals = JSON.parse(fs.readFileSync(canalsPath, 'utf8'));
const removed = canals.filter(c => idsToRemove.has(c.channelId));
const kept = canals.filter(c => !idsToRemove.has(c.channelId));

fs.writeFileSync(canalsPath, JSON.stringify(kept, null, 2) + '\n', 'utf8');

console.log(`Removed ${removed.length} channels (kept ${kept.length}):`);
for (const c of removed) console.log(`  ${c.channelId}\t${c.name}`);
