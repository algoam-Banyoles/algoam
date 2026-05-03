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

function parseLiveHtml(html) {
  const videoIdMatch = html.match(/"videoId":"([\w-]{11})"/);
  if (!videoIdMatch) return null;
  const videoId = videoIdMatch[1];
  const isLive = /"isLiveContent":true/.test(html) || /"isLiveNow":true/.test(html);
  let title = '';
  const t1 = html.match(/<meta name="title" content="([^"]+)"/);
  if (t1) {
    title = t1[1];
  } else {
    const t2 = html.match(/<title>([^<]+) - YouTube<\/title>/);
    if (t2) title = t2[1];
  }
  return { videoId, isLive, title };
}

async function checkChannelLive(channel) {
  const paths = [];
  if (channel.handle) paths.push(`https://www.youtube.com/${channel.handle}/live`);
  if (channel.channelId) paths.push(`https://www.youtube.com/channel/${channel.channelId}/live`);

  for (const livePath of paths) {
    try {
      const res = await fetch(livePath, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      log(`[GET] ${livePath} -> ${res.status} ${res.url}`);
      if (!res.ok) continue;
      const html = await res.text();
      const parsed = parseLiveHtml(html);
      if (parsed && parsed.videoId && parsed.isLive) {
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
