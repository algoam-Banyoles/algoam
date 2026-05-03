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

function extractInitialPlayerResponse(html) {
  const idx = html.indexOf('ytInitialPlayerResponse');
  if (idx < 0) return null;
  const startBrace = html.indexOf('{', idx);
  if (startBrace < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
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

// Detecció robusta: videoDetails.isLive (true només en emissió actual).
function parseLiveHtml(html) {
  const ipr = extractInitialPlayerResponse(html);
  if (!ipr) return null;
  const vd = ipr.videoDetails;
  if (!vd || !vd.videoId) return null;
  if (vd.isUpcoming === true) return null;
  if (vd.isLive !== true) return null;
  const lbd = ipr.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
  if (lbd && lbd.isLiveNow === false) return null;
  return { videoId: vd.videoId, isLive: true, title: vd.title || '' };
}

async function checkChannelLive(channel) {
  const paths = [];
  if (channel.handle) paths.push(`https://www.youtube.com/${channel.handle}/live`);
  if (channel.channelId) paths.push(`https://www.youtube.com/channel/${channel.channelId}/live`);

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
      log(`[GET] ${livePath} -> ${res.status} ${res.url}`);
      if (!res.ok) continue;
      const html = await res.text();
      const parsed = parseLiveHtml(html);
      if (parsed) {
        return {
          url: `https://www.youtube.com/watch?v=${parsed.videoId}`,
          title: parsed.title,
        };
      }
    } catch (err) {
      log(`[ERR] ${livePath} ${err.message}`);
    }
  }
  return null;
}

async function main() {
  const channels = await loadChannels();
  for (const channel of channels) {
    try {
      const info = await checkChannelLive(channel);
      if (info) {
        log(`OK ${channel.name} en emissió: ${info.url}${info.title ? ` — ${info.title}` : ''}`);
      } else {
        log(`KO ${channel.name} sense emissió`);
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
