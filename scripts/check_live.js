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

// Mantén sincronitzat amb canal.js i scripts/poll_and_post.js. YouTube
// serveix dos formats a /streams: l'antic videoRenderer i el nou
// lockupViewModel (rollout des de finals de 2024). Si només llegim el
// primer, els canals migrats apareixen com a offline.
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
