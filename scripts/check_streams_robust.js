// Comprova /streams de cada canal de canals.json N vegades i marca el
// millor resultat (max total streams trobats). Imprimeix els que mai
// no han mostrat streams (candidats a esborrar).

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ITERATIONS = 4;
const SCRIPT = path.join(__dirname, 'check_streams.js');

const canals = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'canals.json'), 'utf8'));
const idsArg = process.argv.slice(2);
const targetIds = idsArg.length ? idsArg : canals.map(c => c.channelId);

async function runOnce(ids) {
  return new Promise((resolve, reject) => {
    const p = spawn('node', [SCRIPT, ...ids], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('close', () => {
      const lines = out.split('\n').filter(l => l && !l.startsWith('STATUS\t'));
      resolve(lines);
    });
    p.on('error', reject);
  });
}

(async () => {
  // best per channel: { status, total }
  const best = new Map();
  for (let it = 0; it < ITERATIONS; it++) {
    process.stderr.write(`Iteration ${it + 1}/${ITERATIONS}…\n`);
    const lines = await runOnce(targetIds);
    for (const line of lines) {
      const [status, cid, name, total] = line.split('\t');
      if (!cid) continue;
      const t = Number(total) || 0;
      const cur = best.get(cid) || { name, status, total: -1 };
      if (t > cur.total || (status === 'HAS-STREAMS' && cur.status !== 'HAS-STREAMS')) {
        best.set(cid, { name, status, total: t });
      }
    }
  }

  console.log('\n=== Final aggregated result ===');
  console.log('STATUS\tchannelId\tname\tbest-total');
  const noStreams = [];
  for (const cid of targetIds) {
    const r = best.get(cid);
    if (!r) {
      console.log(`UNKNOWN\t${cid}\t-\t-`);
      continue;
    }
    console.log(`${r.status}\t${cid}\t${r.name}\t${r.total}`);
    if (r.status === 'NO-STREAMS') noStreams.push(cid);
  }

  console.log(`\n${noStreams.length} channels never returned streams across ${ITERATIONS} iterations:`);
  for (const cid of noStreams) {
    const ch = canals.find(c => c.channelId === cid);
    console.log(`  ${cid}\t${ch?.name || '?'}`);
  }
})();
