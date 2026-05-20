/*!
 * Billar en Directe — afegeix un canal a canals.json a partir del seu handle.
 *
 * Ús:
 *   node scripts/add_channel.js @handle [--federation FCB|RFEB] [--modality pool|snooker|altres] [--name "Nom personalitzat"]
 *
 * Exemples:
 *   node scripts/add_channel.js @MatchroomPool1 --modality pool
 *   node scripts/add_channel.js clubbillarvic3334 --federation FCB
 */

const fsp = require('fs/promises');
const path = require('path');

const CANALS_PATH = path.resolve(__dirname, '..', 'canals.json');

function parseArgs(argv) {
  const args = { handle: null, federation: null, modality: null, name: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--federation' || a === '-f') args.federation = argv[++i];
    else if (a === '--modality' || a === '-m') args.modality = argv[++i];
    else if (a === '--name' || a === '-n') args.name = argv[++i];
    else if (a.startsWith('-')) throw new Error(`Opció desconeguda: ${a}`);
    else if (!args.handle) args.handle = a;
    else throw new Error(`Argument inesperat: ${a}`);
  }
  return args;
}

function normalizeHandle(input) {
  if (!input) return null;
  let h = input.trim();
  // Acceptem URL completa "https://www.youtube.com/@xxx" → extraem el handle.
  const m = h.match(/youtube\.com\/(@[\w.\-]+)/i);
  if (m) h = m[1];
  if (!h.startsWith('@')) h = '@' + h;
  // El handle de YouTube només permet [A-Za-z0-9._-] i ha de contenir
  // almenys un caràcter alfanumèric (rebutja "@---", "@..." i flags com "@--help").
  if (!/^@[\w.\-]{3,}$/.test(h)) return null;
  if (!/[A-Za-z0-9]/.test(h.slice(1))) return null;
  return h;
}

async function fetchChannelInfo(handle) {
  const url = `https://www.youtube.com/${handle}`;
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie': 'CONSENT=YES+1',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} en obtenir ${url}`);
  const html = await res.text();

  const idMatch = html.match(/"channelId":"(UC[\w-]{22})"/) ||
                  html.match(/\/channel\/(UC[\w-]{22})/);
  if (!idMatch) throw new Error(`No s'ha trobat channelId per ${handle}. El canal existeix?`);
  const channelId = idMatch[1];

  let name = null;
  const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/);
  if (ogTitle) name = ogTitle[1];
  if (!name) {
    const t = html.match(/<title>([^<]+)<\/title>/);
    if (t) name = t[1].replace(/\s*-\s*YouTube\s*$/, '').trim();
  }
  if (!name) name = handle.replace(/^@/, '');

  return { channelId, name };
}

async function loadCanals() {
  const data = await fsp.readFile(CANALS_PATH, 'utf8');
  return JSON.parse(data);
}

async function saveCanals(canals) {
  const json = JSON.stringify(canals, null, 2) + '\n';
  await fsp.writeFile(CANALS_PATH, json, 'utf8');
}

async function main() {
  const { handle: rawHandle, federation, modality, name: customName } = parseArgs(process.argv.slice(2));
  const handle = normalizeHandle(rawHandle);
  if (!handle) {
    console.error('Ús: node scripts/add_channel.js @handle [--federation FCB|RFEB] [--modality pool|snooker|altres] [--name "Nom"]');
    process.exit(1);
  }

  console.log(`Buscant ${handle} a YouTube…`);
  const info = await fetchChannelInfo(handle);
  const finalName = customName || info.name;

  const canals = await loadCanals();
  const dup = canals.find(c =>
    c.channelId === info.channelId ||
    (c.handle && c.handle.toLowerCase() === handle.toLowerCase())
  );
  if (dup) {
    console.log(`⚠️  Ja existeix: "${dup.name}" (${dup.channelId || dup.handle}). No s'afegeix.`);
    return;
  }

  const entry = {
    name: finalName,
    channelId: info.channelId,
    handle,
  };
  if (federation) entry.federation = federation;
  if (modality) entry.modality = modality;

  canals.push(entry);
  await saveCanals(canals);
  console.log(`✅ Afegit: "${entry.name}" — ${entry.channelId} (${entry.handle})`);
  if (entry.federation) console.log(`   federation: ${entry.federation}`);
  if (entry.modality) console.log(`   modality: ${entry.modality}`);
  console.log(`Total canals: ${canals.length}`);
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
