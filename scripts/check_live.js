const fs = require('fs/promises');

// Default API key if not provided via environment
const API_KEY = process.env.API_KEY || 'AIzaSyAgQNSOrxd5EQYZTbLpY63mcafFOP519Jo';

async function loadChannels() {
  const data = await fs.readFile('canals.json', 'utf8');
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
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      const match = location && location.match(/v=([\w-]{11})/);
      if (match) videoId = match[1];
    }

    if (!videoId) {
      res = await fetch(livePath, { redirect: 'follow' });
      const finalUrl = res.url;
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
      const apiRes = await fetch(apiUrl);
      const data = await apiRes.json();
      if (apiRes.ok && data.items && data.items.length > 0) {
        meta = data.items[0];
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
        console.log(message);
      } else {
        console.log(`KO ${channel.name} sense emissió`);
      }
    } catch (err) {
      console.error('Error checking', channel.channelId, err.message);
      console.log(`KO ${channel.name} sense emissió`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
