// Comprova quins canals tenen vídeos a /streams (és a dir, fan o han fet
// directes). Llegeix els canals des de canals.json i els ids passats per
// argv (o tots si no se'n passa cap). Imprimeix una línia per canal amb:
//   STATUS | channelId | name | livePastCount | upcomingCount | latestLive
// STATUS: LIVE-OK (té streams), NO-STREAMS (cap), ERROR (fetch/parse)

const fs = require('fs');
const path = require('path');

const TIMEOUT_MS = 12000;
const CONCURRENCY = 8;

async function fetchWithTimeout(url, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': 'CONSENT=YES+1',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  } finally {
    clearTimeout(t);
  }
}

function extractYtInitialData(html) {
  const idx = html.indexOf('ytInitialData');
  if (idx < 0) return null;
  const startBrace = html.indexOf('{', idx);
  if (startBrace < 0) return null;
  let depth = 0, inString = false, escape = false;
  for (let i = startBrace; i < html.length; i++) {
    const c = html[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { try { return JSON.parse(html.slice(startBrace, i + 1)); } catch { return null; } }
    }
  }
  return null;
}

function walkVideoRenderers(obj, cb) {
  if (Array.isArray(obj)) { for (const item of obj) walkVideoRenderers(item, cb); return; }
  if (obj && typeof obj === 'object') {
    if (obj.videoRenderer) cb(obj.videoRenderer);
    if (obj.gridVideoRenderer) cb(obj.gridVideoRenderer);
    for (const k of Object.keys(obj)) {
      if (k === 'videoRenderer' || k === 'gridVideoRenderer') continue;
      walkVideoRenderers(obj[k], cb);
    }
  }
}

function classifyVideo(vr) {
  // status flags from thumbnailOverlays
  const overlays = vr.thumbnailOverlays || [];
  for (const overlay of overlays) {
    const tos = overlay.thumbnailOverlayTimeStatusRenderer;
    if (tos) {
      if (tos.style === 'LIVE') return 'live';
      if (tos.style === 'UPCOMING') return 'upcoming';
    }
  }
  const badges = vr.badges || [];
  for (const badge of badges) {
    const mbr = badge.metadataBadgeRenderer;
    if (mbr?.label === 'LIVE NOW' || mbr?.style === 'BADGE_STYLE_TYPE_LIVE_NOW') return 'live';
  }
  const ed = vr.publishedTimeText?.simpleText || vr.publishedTimeText?.runs?.[0]?.text || '';
  if (/streamed|fa\s+(\d+|un|una)|hace\s+/i.test(ed)) return 'past-live';
  // Default: count as past-live since we're on /streams page
  return 'past-live';
}

async function checkChannel(channel) {
  const paths = [];
  if (channel.handle) paths.push(`https://www.youtube.com/${channel.handle}/streams`);
  if (channel.channelId) paths.push(`https://www.youtube.com/channel/${channel.channelId}/streams`);

  let last;
  for (const url of paths) {
    try {
      const html = await fetchWithTimeout(url);
      const data = extractYtInitialData(html);
      if (!data) { last = 'parse-failed'; continue; }
      let live = 0, upcoming = 0, past = 0, total = 0;
      const seen = new Set();
      walkVideoRenderers(data, vr => {
        if (!vr.videoId || seen.has(vr.videoId)) return;
        seen.add(vr.videoId);
        total++;
        const c = classifyVideo(vr);
        if (c === 'live') live++;
        else if (c === 'upcoming') upcoming++;
        else past++;
      });
      return { ok: true, total, live, upcoming, past };
    } catch (err) {
      last = err.message;
    }
  }
  return { ok: false, error: last || 'no-paths' };
}

async function pLimit(items, fn, limit) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  }));
  return results;
}

(async () => {
  const canals = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'canals.json'), 'utf8'));
  const filterIds = process.argv.slice(2);
  const targets = filterIds.length ? canals.filter(c => filterIds.includes(c.channelId)) : canals;

  process.stderr.write(`Checking ${targets.length} channels (concurrency ${CONCURRENCY})…\n`);
  const results = await pLimit(targets, async ch => {
    const r = await checkChannel(ch);
    return { ch, r };
  }, CONCURRENCY);

  console.log('STATUS\tchannelId\tname\ttotal\tlive\tupcoming\tpast');
  for (const { ch, r } of results) {
    if (!r.ok) {
      console.log(`ERROR\t${ch.channelId}\t${ch.name}\t-\t-\t-\t${r.error}`);
    } else if (r.total === 0) {
      console.log(`NO-STREAMS\t${ch.channelId}\t${ch.name}\t0\t0\t0\t0`);
    } else {
      console.log(`HAS-STREAMS\t${ch.channelId}\t${ch.name}\t${r.total}\t${r.live}\t${r.upcoming}\t${r.past}`);
    }
  }
})();
