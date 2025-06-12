const fs = require('fs/promises');

const API_KEY = process.env.API_KEY || '';

async function loadChannels() {
  const data = await fs.readFile('canals.json', 'utf8');
  return JSON.parse(data);
}

async function checkChannelLive(channel) {
  if (API_KEY) {
    const apiUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channel.channelId}&eventType=live&type=video&key=${API_KEY}`;
    const res = await fetch(apiUrl);
    const data = await res.json();
    if (res.ok && data.items && data.items.length > 0) {
      return `https://www.youtube.com/watch?v=${data.items[0].id.videoId}`;
    }
    return null;
  }

  const livePath = channel.handle
    ? `https://www.youtube.com/${channel.handle}/live`
    : `https://www.youtube.com/channel/${channel.channelId}/live`;
  const proxyUrl = `https://corsproxy.io/?${livePath}`;
  const res = await fetch(proxyUrl, { redirect: 'follow' });
  if (!res.ok) return null;
  const finalUrl = decodeURIComponent(res.url.replace('https://corsproxy.io/?', ''));
  let match = finalUrl.match(/(?:[?&]v=|\/live\/)([^&/?]+)/);
  if (!match) {
    const html = await res.text();
    match = html.match(/"(?:watch\?v=|videoId\":\")([\w-]{11})/);
  }
  if (match) {
    return `https://www.youtube.com/watch?v=${match[1]}`;
  }
  return null;
}

async function main() {
  const channels = await loadChannels();
  for (const channel of channels) {
    try {
      const url = await checkChannelLive(channel);
      if (url) {
        console.log(`${channel.name}: ${url}`);
      }
    } catch (err) {
      console.error('Error checking', channel.channelId, err.message);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
