// Quick CLI: find the current live videoIds for one channel handle (or all).
// Usage:
//   node scripts/find_live.js KozoomCaromTV
//   node scripts/find_live.js  (all)
const fs = require('fs/promises');

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
      const title = old.title?.runs?.[0]?.text || old.title?.simpleText || '';
      streams.push({ videoId: old.videoId, title });
    }

    const lvm = obj.lockupViewModel;
    if (lvm?.contentId && !seen.has(lvm.contentId) &&
        (!lvm.contentType || lvm.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') &&
        isLiveSubtree(lvm)) {
      seen.add(lvm.contentId);
      const title = lvm.metadata?.lockupMetadataViewModel?.title?.content || '';
      streams.push({ videoId: lvm.contentId, title });
    }

    for (const [k, v] of Object.entries(obj)) {
      if (k === 'videoRenderer' || k === 'gridVideoRenderer' || k === 'lockupViewModel') continue;
      visit(v);
    }
  }
  visit(ytData);
  return streams;
}

async function checkOne(channel) {
  const paths = [];
  if (channel.handle) paths.push(`https://www.youtube.com/${channel.handle}/streams`);
  if (channel.channelId) paths.push(`https://www.youtube.com/channel/${channel.channelId}/streams`);
  for (const p of paths) {
    try {
      const res = await fetch(p, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9', 'Cookie': 'CONSENT=YES+1' },
      });
      if (!res.ok) continue;
      const html = await res.text();
      const yt = extractYtInitialData(html);
      if (!yt) continue;
      return findLiveStreams(yt);
    } catch (_) {}
  }
  return [];
}

(async () => {
  const filter = process.argv[2];
  const all = JSON.parse(await fs.readFile('canals.json', 'utf8'));
  const channels = filter
    ? all.filter(c => (c.handle || '').toLowerCase().includes(filter.toLowerCase())
        || (c.name || '').toLowerCase().includes(filter.toLowerCase()))
    : all;
  for (const ch of channels) {
    const streams = await checkOne(ch);
    if (streams.length === 0) continue;
    console.log(`${ch.name}  (${ch.handle || ch.channelId})`);
    for (const s of streams) {
      console.log(`  ${s.videoId}  ${s.title}`);
    }
  }
})();
