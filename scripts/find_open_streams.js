// Descobreix els directes de YouTube dels clubs que acullen un open, limitant
// la cerca als canals de `canals.json` el nom dels quals conté algun dels tokens
// de seu passats per argument (p.ex. "tarragona", "mont", "sants").
//
// Reusa el mètode sense API de check_live.js (fetch a @handle/streams + parse
// de ytInitialData) per trobar els videoId en directe de cada canal.
//
// Ús:  node scripts/find_open_streams.js tarragona mont sants
const fs = require('fs');

function norm(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

function extractYtInitialData(html) {
  const idx = html.indexOf('ytInitialData');
  if (idx < 0) return null;
  const start = html.indexOf('{', idx);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

function isLiveSubtree(node) {
  const stack = [node];
  while (stack.length) {
    const x = stack.pop();
    if (Array.isArray(x)) { for (const y of x) stack.push(y); continue; }
    if (!x || typeof x !== 'object') continue;
    for (const [k, v] of Object.entries(x)) {
      if (k === 'thumbnailOverlayTimeStatusRenderer' && v?.style === 'LIVE') return true;
      if (k === 'metadataBadgeRenderer' && (v?.label === 'LIVE NOW' || v?.style === 'BADGE_STYLE_TYPE_LIVE_NOW')) return true;
      if (k === 'thumbnailBadgeViewModel' && v?.badgeStyle === 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE') return true;
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return false;
}

function findLiveStreams(yt) {
  const out = [], seen = new Set();
  (function visit(o) {
    if (Array.isArray(o)) { for (const x of o) visit(x); return; }
    if (!o || typeof o !== 'object') return;
    const old = o.videoRenderer || o.gridVideoRenderer;
    if (old?.videoId && !seen.has(old.videoId) && isLiveSubtree(old)) {
      seen.add(old.videoId);
      out.push({ videoId: old.videoId, title: old.title?.runs?.[0]?.text || '' });
    }
    const lvm = o.lockupViewModel;
    if (lvm?.contentId && !seen.has(lvm.contentId) &&
        (!lvm.contentType || lvm.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') && isLiveSubtree(lvm)) {
      seen.add(lvm.contentId);
      out.push({ videoId: lvm.contentId, title: lvm.metadata?.lockupMetadataViewModel?.title?.content || '' });
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === 'videoRenderer' || k === 'gridVideoRenderer' || k === 'lockupViewModel') continue;
      visit(v);
    }
  })(yt);
  return out;
}

async function channelLive(ch) {
  const paths = [];
  if (ch.handle) paths.push(`https://www.youtube.com/${ch.handle}/streams`);
  if (ch.channelId) paths.push(`https://www.youtube.com/channel/${ch.channelId}/streams`);
  for (const url of paths) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9', 'Cookie': 'CONSENT=YES+1' } });
      if (!res.ok) continue;
      const yt = extractYtInitialData(await res.text());
      if (!yt) continue;
      const s = findLiveStreams(yt);
      if (s.length) return s;
    } catch { /* ignore */ }
  }
  return [];
}

// Verifica que un vídeo emet EN DIRECTE ARA (no un VOD ni un directe just acabat).
// El badge "LIVE" de la pàgina /streams pot quedar enganxat uns minuts després
// d'acabar; la pàgina watch té "isLiveNow" (autoritatiu) i, mentre emet de debò,
// hi ha "hlsManifestUrl". Així evitem llegir un VOD i publicar un marcador antic.
async function verifyLiveNow(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9', 'Cookie': 'CONSENT=YES+1' },
    });
    if (!res.ok) return false;
    const html = await res.text();
    if (/"isLiveNow"\s*:\s*true/.test(html)) return true;
    if (/"isLiveNow"\s*:\s*false/.test(html)) return false;
    return /"hlsManifestUrl"\s*:\s*"/.test(html);  // fallback: HLS només mentre emet
  } catch { return false; }
}

const path = require('path');
const CANALS = path.join(__dirname, '..', 'canals.json');

// Directes dels canals el nom dels quals conté algun token de seu.
// Retorna [{channel, videoId, url, title}].
async function liveStreamsForTokens(tokens, { canalsPath = CANALS, onLog = () => {} } = {}) {
  const T = tokens.map(norm);
  const chans = JSON.parse(fs.readFileSync(canalsPath, 'utf8'));
  const targets = chans.filter((c) => T.some((t) => norm(c.name).includes(t)));
  onLog(`Canals candidats: ${targets.length} (de ${chans.length})`);
  const results = [];
  for (const ch of targets) {
    const streams = await channelLive(ch);
    const liveIds = [];
    for (const s of streams) {
      // Confirma que emet EN DIRECTE ARA (descarta VODs/directes acabats).
      if (!(await verifyLiveNow(s.videoId))) { onLog(`  (descartat, no és directe ara: ${s.videoId})`); continue; }
      results.push({ channel: ch.name, videoId: s.videoId, url: `https://www.youtube.com/watch?v=${s.videoId}`, title: s.title });
      liveIds.push(s.videoId);
    }
    onLog(`${liveIds.length ? 'LIVE' : ' -- '} ${ch.name}${liveIds.length ? ' -> ' + liveIds.join(',') : ''}`);
  }
  return results;
}

module.exports = { liveStreamsForTokens, channelLive, verifyLiveNow, norm };

if (require.main === module) {
  const tokens = process.argv.slice(2);
  if (!tokens.length) { console.error('cal almenys un token de seu'); process.exit(1); }
  liveStreamsForTokens(tokens, { onLog: (m) => console.error(m) })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error('ERR', e.message); process.exit(1); });
}
