const fs = require('fs');
const fsp = require('fs/promises');

const logFile = process.env.LOG_FILE || 'check_live.log';
const logStream = fs.createWriteStream(logFile, { flags: 'a' });
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

async function loadChannels() {
  const data = await fsp.readFile('canals.json', 'utf8');
  return JSON.parse(data);
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
  const seen = new Set();
  walkVideoRenderers(ytData, vr => {
    if (!vr.videoId || seen.has(vr.videoId)) return;
    if (!isVideoRendererLive(vr)) return;
    seen.add(vr.videoId);
    const title = vr.title?.runs?.[0]?.text || vr.title?.simpleText || '';
    streams.push({ videoId: vr.videoId, title });
  });
  return streams;
}

async function checkChannelLive(channel) {
  const paths = [];
  if (channel.handle) paths.push(`https://www.youtube.com/${channel.handle}/streams`);
  if (channel.channelId) paths.push(`https://www.youtube.com/channel/${channel.channelId}/streams`);

  for (const livePath of paths) {
    try {
      const res = await fetch(livePath, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cookie': 'CONSENT=YES+1',
        },
      });
      log(`[GET] ${livePath} -> ${res.status}`);
      if (!res.ok) continue;
      const html = await res.text();
      const ytData = extractYtInitialData(html);
      if (!ytData) continue;
      const streams = findLiveStreams(ytData);
      if (streams.length > 0) return streams;
    } catch (err) {
      log(`[ERR] ${livePath} ${err.message}`);
    }
  }
  return [];
}

async function main() {
  const channels = await loadChannels();
  for (const channel of channels) {
    try {
      const streams = await checkChannelLive(channel);
      if (streams.length === 0) {
        log(`KO ${channel.name} sense emissió`);
      } else if (streams.length === 1) {
        log(`OK ${channel.name} en emissió: https://www.youtube.com/watch?v=${streams[0].videoId} — ${streams[0].title}`);
      } else {
        log(`OK ${channel.name} ${streams.length} emissions simultànies:`);
        for (const s of streams) {
          log(`     https://www.youtube.com/watch?v=${s.videoId} — ${s.title}`);
        }
      }
    } catch (err) {
      log(`Error checking ${channel.channelId} ${err.message}`);
      log(`KO ${channel.name} sense emissió`);
    }
  }
}

main().catch(err => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
