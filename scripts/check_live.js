const fs = require('fs');
const fsp = require('fs/promises');

// Simple logger that writes to both stdout and a file
const logFile = process.env.LOG_FILE || 'check_live.log';
const logStream = fs.createWriteStream(logFile, { flags: 'a' });
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

// API key for the YouTube Data API. Provide it via the `API_KEY` environment variable.
const API_KEY = process.env.API_KEY || '';

async function loadChannels() {
  const data = await fsp.readFile('canals.json', 'utf8');
  return JSON.parse(data);
}

async function checkChannelLive(channel) {
  const paths = [];
  if (channel.handle) {
    paths.push(`https://www.youtube.com/${channel.handle}/live`);
  }
  if (channel.channelId) {
    paths.push(`https://www.youtube.com/channel/${channel.channelId}/live`);
  }

  let videoId = null;
  for (const livePath of paths) {
    let res = await fetch(livePath, { method: 'HEAD', redirect: 'manual' });
    const headLocation = res.headers.get('location');
    log(`[HEAD] ${livePath} -> ${res.status}${headLocation ? ` ${headLocation}` : ''}`);
    if (res.status >= 300 && res.status < 400) {
      const location = headLocation;
      const match = location && location.match(/v=([\w-]{11})/);
      if (match) videoId = match[1];
    }

    if (!videoId) {
      res = await fetch(livePath, { redirect: 'follow' });
      const finalUrl = res.url;
      log(`[GET] ${livePath} -> ${res.status} ${finalUrl}`);
      let match = finalUrl.match(/[?&]v=([\w-]{11})/);
      if (!match && res.ok) {
        const html = await res.text();
        match = html.match(/"(?:watch\?v=|videoId\":\")([\w-]{11})/);
      }
      if (match) videoId = match[1];
    }

    if (videoId) break;
  }

  if (videoId) {
    let meta = null;
    if (API_KEY) {
      const apiUrl =
        `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${videoId}&key=${API_KEY}`;
      log(`[API] ${apiUrl}`);
      const apiRes = await fetch(apiUrl);
      const data = await apiRes.json();
      if (apiRes.ok && data.items && data.items.length > 0) {
        meta = data.items[0];
        const live = meta.snippet.liveBroadcastContent === 'live' ||
          (meta.liveStreamingDetails &&
           meta.liveStreamingDetails.actualStartTime &&
           !meta.liveStreamingDetails.actualEndTime);
        if (!live) {
          return null;
        }
      }
    }
    return { url: `https://www.youtube.com/watch?v=${videoId}`, meta };
  }

  return null;
}

async function main() {
  const channels = await loadChannels();
  for (const channel of channels) {
    try {
      const info = await checkChannelLive(channel);
      if (info) {
        let message = `OK ${channel.name} en emissió: ${info.url}`;
        const viewers = info.meta?.liveStreamingDetails?.concurrentViewers;
        if (viewers) {
          message += ` (${viewers} espectadors)`;
        }
        log(message);
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
