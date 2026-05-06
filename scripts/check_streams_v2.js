// Versió estricta: només considera "live broadcaster" un canal si la
// pestanya retornada per /streams és realment de directes (titulada
// "Live"/"Directes"/"Streams"/"En directe") i conté com a mínim un
// vídeo amb marca "Streamed ... ago" o "LIVE NOW".
//
// La versió anterior (check_streams.js) caia en un fals positiu quan
// el canal no tenia pestanya Live: YouTube llavors mostra Home, i el
// walker comptava els vídeos pujats normals com a streams.

const fs = require('fs');
const path = require('path');

const ITERATIONS = 4;
const TIMEOUT_MS = 15000;
const CONCURRENCY = 6;

const LIVE_TAB_TITLES = new Set([
  'live', 'lives', 'streams', 'directes', 'directos',
  'en directe', 'en directo', 'transmisiones', 'transmissions', '直播',
]);

async function fetchPage(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
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
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function extractYtInitialData(html) {
  const idx = html.indexOf('ytInitialData');
  if (idx < 0) return null;
  const start = html.indexOf('{', idx);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; } }
    }
  }
  return null;
}

function findSelectedLiveTab(data) {
  const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
  for (const t of tabs) {
    const tab = t.tabRenderer || t.expandableTabRenderer;
    if (!tab?.selected) continue;
    const title = (tab.title || '').toLowerCase().trim();
    return { title, content: tab.content, isLive: LIVE_TAB_TITLES.has(title) };
  }
  return null;
}

// Compta videoIds amb marca "Streamed ... ago" o LIVE / UPCOMING explícits.
function countLiveOnly(content) {
  if (!content) return { real: 0, total: 0, recent: 0 };
  const json = JSON.stringify(content);
  const totalIds = new Set(Array.from(json.matchAll(/"videoId":"([\w-]{11})"/g)).map(m => m[1])).size;
  const streamedAgo = (json.match(/"simpleText":"Streamed [^"]+"/g) || []).length;
  const liveBadge = (json.match(/"style":"BADGE_STYLE_TYPE_LIVE_NOW"|"style":"LIVE"/g) || []).length;
  // Recent: Streamed within last 6 months (days/weeks/months ≤ 6)
  let recent = 0;
  for (const m of json.matchAll(/"simpleText":"Streamed (\d+) (day|week|month|year)s? ago"/g)) {
    const n = Number(m[1]);
    const u = m[2];
    if (u === 'day' || u === 'week') recent++;
    else if (u === 'month' && n <= 6) recent++;
  }
  return { real: streamedAgo + liveBadge, total: totalIds, recent };
}

async function checkChannelOnce(ch) {
  const candidates = [];
  if (ch.handle) candidates.push(`https://www.youtube.com/${ch.handle}/streams`);
  if (ch.channelId) candidates.push(`https://www.youtube.com/channel/${ch.channelId}/streams`);
  let lastErr;
  for (const url of candidates) {
    try {
      const html = await fetchPage(url);
      const data = extractYtInitialData(html);
      if (!data) { lastErr = 'parse'; continue; }
      const tab = findSelectedLiveTab(data);
      if (!tab) return { error: 'no-tab-selected' };
      if (!tab.isLive) return { liveTab: false, tabTitle: tab.title, real: 0, recent: 0 };
      const { real, total, recent } = countLiveOnly(tab.content);
      return { liveTab: true, tabTitle: tab.title, real, total, recent };
    } catch (err) { lastErr = err.message; }
  }
  return { error: lastErr || 'unknown' };
}

async function checkChannel(ch) {
  let best = null;
  for (let i = 0; i < ITERATIONS; i++) {
    const r = await checkChannelOnce(ch);
    if (r.error) continue;
    if (!best || (r.real > (best.real || 0)) || (r.recent > (best.recent || 0))) best = r;
  }
  return best || { error: 'all-failed' };
}

async function pLimit(items, fn, limit) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  }));
  return out;
}

(async () => {
  const canals = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'canals.json'), 'utf8'));
  const filterIds = process.argv.slice(2);
  const targets = filterIds.length ? canals.filter(c => filterIds.includes(c.channelId)) : canals;

  process.stderr.write(`Checking ${targets.length} channels (strict, ${ITERATIONS} iter)…\n`);
  const results = await pLimit(targets, async ch => ({ ch, r: await checkChannel(ch) }), CONCURRENCY);

  console.log('STATUS\tchannelId\tname\tliveTab\trealStreams\trecentStreams\tnotes');
  const drop = [];
  for (const { ch, r } of results) {
    if (r.error) {
      console.log(`ERROR\t${ch.channelId}\t${ch.name}\t-\t-\t-\t${r.error}`);
      continue;
    }
    if (!r.liveTab) {
      console.log(`NO-LIVE-TAB\t${ch.channelId}\t${ch.name}\tno\t0\t0\ttab="${r.tabTitle}"`);
      drop.push(ch);
      continue;
    }
    if (r.real === 0) {
      console.log(`EMPTY-LIVE-TAB\t${ch.channelId}\t${ch.name}\tyes\t0\t0\t-`);
      drop.push(ch);
      continue;
    }
    const verdict = r.recent > 0 ? 'ACTIVE' : 'STALE';
    console.log(`${verdict}\t${ch.channelId}\t${ch.name}\tyes\t${r.real}\t${r.recent}\t-`);
  }

  console.log(`\n${drop.length} channels lack a real Live tab or empty:`);
  for (const c of drop) console.log(`  ${c.channelId}\t${c.name}`);
})();
