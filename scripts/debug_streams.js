// Debug helper: fetch a channel's /streams page through codetabs proxy
// and list all currently-live streams found in ytInitialData.
// Usage: node scripts/debug_streams.js @handle

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
        catch (e) { return null; }
      }
    }
  }
  return null;
}

function isVideoRendererLive(vr) {
  const overlays = vr.thumbnailOverlays || [];
  for (const overlay of overlays) {
    const tos = overlay.thumbnailOverlayTimeStatusRenderer;
    if (tos && tos.style === 'LIVE') return true;
  }
  const badges = vr.badges || [];
  for (const badge of badges) {
    const mbr = badge.metadataBadgeRenderer;
    if (mbr && (mbr.label === 'LIVE NOW' || mbr.style === 'BADGE_STYLE_TYPE_LIVE_NOW')) return true;
  }
  return false;
}

function walkVideoRenderers(obj, cb) {
  if (Array.isArray(obj)) {
    for (const item of obj) walkVideoRenderers(item, cb);
    return;
  }
  if (obj && typeof obj === 'object') {
    if (obj.videoRenderer) cb(obj.videoRenderer);
    if (obj.gridVideoRenderer) cb(obj.gridVideoRenderer);
    for (const key of Object.keys(obj)) {
      if (key === 'videoRenderer' || key === 'gridVideoRenderer') continue;
      walkVideoRenderers(obj[key], cb);
    }
  }
}

function findLiveStreams(ytData) {
  const streams = [];
  walkVideoRenderers(ytData, vr => {
    if (!vr.videoId) return;
    if (isVideoRendererLive(vr)) {
      const title = vr.title?.runs?.[0]?.text || vr.title?.simpleText || '';
      streams.push({ videoId: vr.videoId, title });
    }
  });
  return streams;
}

async function main() {
  const arg = process.argv[2];
  const target = arg.startsWith('@')
    ? `https://www.youtube.com/${arg}/streams`
    : `https://www.youtube.com/channel/${arg}/streams`;
  const url = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(target)}`;
  console.log(`Fetching ${url}`);
  const res = await fetch(url, { redirect: 'follow', headers: { 'Accept-Language': 'en-US,en;q=0.9' } });
  console.log(`Status: ${res.status}, length: ${(await res.clone().text()).length}`);
  const html = await res.text();
  const ytData = extractYtInitialData(html);
  if (!ytData) { console.log('NO ytInitialData'); return; }
  const streams = findLiveStreams(ytData);
  console.log(`Found ${streams.length} live streams:`);
  for (const s of streams) console.log(`  ${s.videoId} | ${s.title}`);
}

main().catch(err => console.error('Fatal:', err));
