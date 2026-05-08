// Run by GitHub Actions every 5 minutes. Scrapes /streams of every channel
// in canals.json (in parallel), parses live videoIds + titles, and POSTs
// the aggregated state to the Cloudflare Worker /poll endpoint, which
// stores it in KV and dispatches Web Push notifications for any newly-live
// videoIds. The worker also serves this same state via /all-live so the
// PWA can hydrate instantly without re-scraping.
//
// Required env vars:
//   WORKER_URL    e.g. https://algoam-push.xxx.workers.dev
//   POLL_SECRET   shared secret matching the worker's POLL_SECRET
//
// Run locally for testing:
//   WORKER_URL=... POLL_SECRET=... node scripts/poll_and_post.js

const fs = require('fs/promises');

const WORKER_URL = process.env.WORKER_URL;
const POLL_SECRET = process.env.POLL_SECRET;
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '10', 10);

if (!WORKER_URL || !POLL_SECRET) {
  console.error('Missing WORKER_URL or POLL_SECRET');
  process.exit(1);
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
      if (depth === 0) {
        try { return JSON.parse(html.slice(startBrace, i + 1)); }
        catch (_) { return null; }
      }
    }
  }
  return null;
}

// Mantén sincronitzat amb canal.js i scripts/check_live.js. YouTube serveix
// dos formats a /streams: l'antic videoRenderer i el nou lockupViewModel
// (rollout des de finals de 2024). Si només llegim el primer, els canals
// migrats apareixen com a offline.
function isLiveSubtree(node) {
  const stack = [node];
  while (stack.length) {
    const x = stack.pop();
    if (Array.isArray(x)) { for (const y of x) stack.push(y); continue; }
    if (!x || typeof x !== 'object') continue;
    for (const [k, v] of Object.entries(x)) {
      if (k === 'thumbnailOverlayTimeStatusRenderer' && v?.style === 'LIVE') return true;
      if (k === 'metadataBadgeRenderer' &&
          (v?.label === 'LIVE NOW' || v?.style === 'BADGE_STYLE_TYPE_LIVE_NOW')) return true;
      if (k === 'thumbnailBadgeViewModel' &&
          v?.badgeStyle === 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE') return true;
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return false;
}

function findLiveStreams(ytData) {
  const streams = [];
  const seen = new Set();
  function visit(obj) {
    if (Array.isArray(obj)) { for (const x of obj) visit(x); return; }
    if (!obj || typeof obj !== 'object') return;

    const old = obj.videoRenderer || obj.gridVideoRenderer;
    if (old?.videoId && !seen.has(old.videoId) && isLiveSubtree(old)) {
      seen.add(old.videoId);
      streams.push({
        videoId: old.videoId,
        title: old.title?.runs?.[0]?.text || old.title?.simpleText || '',
      });
    }

    const lvm = obj.lockupViewModel;
    if (lvm?.contentId && !seen.has(lvm.contentId) &&
        (!lvm.contentType || lvm.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') &&
        isLiveSubtree(lvm)) {
      seen.add(lvm.contentId);
      streams.push({
        videoId: lvm.contentId,
        title: lvm.metadata?.lockupMetadataViewModel?.title?.content || '',
      });
    }

    for (const [k, v] of Object.entries(obj)) {
      if (k === 'videoRenderer' || k === 'gridVideoRenderer' || k === 'lockupViewModel') continue;
      visit(v);
    }
  }
  visit(ytData);
  return streams;
}

function channelKey(ch) {
  return ch.channelId || ch.handle || ch.name;
}

async function checkOne(channel) {
  const paths = [];
  if (channel.handle) paths.push(`https://www.youtube.com/${channel.handle}/streams`);
  if (channel.channelId) paths.push(`https://www.youtube.com/channel/${channel.channelId}/streams`);
  for (const p of paths) {
    try {
      const res = await fetch(p, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AlgoamBot/1.0)',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cookie': 'CONSENT=YES+1',
        },
      });
      if (!res.ok) continue;
      const html = await res.text();
      const ytData = extractYtInitialData(html);
      if (!ytData) continue;
      return findLiveStreams(ytData);
    } catch (_) { /* try next */ }
  }
  return [];
}

async function pLimit(limit, items, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const channels = JSON.parse(await fs.readFile('canals.json', 'utf8'));
  const results = new Array(channels.length);
  const t0 = Date.now();
  await pLimit(CONCURRENCY, channels, async (ch, idx) => {
    const streams = await checkOne(ch);
    results[idx] = {
      channelKey: channelKey(ch),
      name: ch.name,
      streams,
    };
    if (streams.length > 0) {
      console.log(`LIVE  ${ch.name} (${streams.length} stream${streams.length > 1 ? 's' : ''})`);
    }
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const liveCount = results.filter(r => r.streams.length > 0).length;
  console.log(`Scraped ${channels.length} channels in ${elapsed}s; ${liveCount} live`);

  const res = await fetch(`${WORKER_URL}/poll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${POLL_SECRET}`,
    },
    body: JSON.stringify({ channels: results }),
  });
  const body = await res.text();
  console.log(`Worker /poll -> ${res.status} ${body}`);
  if (!res.ok) process.exit(1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
