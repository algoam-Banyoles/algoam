const http = require('http');
const fs = require('fs/promises');
const { URL, URLSearchParams } = require('url');

const PORT = process.env.PORT || 3000;
const CALLBACK_URL = process.env.CALLBACK_URL || `http://localhost:${PORT}/websub`;
// Allow API key via environment, otherwise fall back to the bundled key
const API_KEY = process.env.API_KEY || 'AIzaSyBbSKKTu-PNoWZ_MPwNnTi5iaFZmsk3dQw';

async function loadChannelIds() {
  const data = await fs.readFile('canals.json', 'utf8');
  const channels = JSON.parse(data);
  return channels.filter(c => c.channelId).map(c => c.channelId);
}

async function subscribe(channelId) {
  const hubUrl = 'https://pubsubhubbub.appspot.com/subscribe';
  const topic = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;
  const params = new URLSearchParams({
    'hub.mode': 'subscribe',
    'hub.topic': topic,
    'hub.callback': CALLBACK_URL,
    'hub.verify': 'async'
  });
  const res = await fetch(hubUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  if (res.ok) {
    console.log('Subscribed to', channelId);
  } else {
    console.error('Failed to subscribe', channelId, res.status, await res.text());
  }
}

async function subscribeAll() {
  const ids = await loadChannelIds();
  for (const id of ids) {
    subscribe(id).catch(err => console.error('Subscription failed', id, err));
  }
}

async function checkVideoLive(videoId) {
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.search = new URLSearchParams({
    part: 'snippet,liveStreamingDetails',
    id: videoId,
    key: API_KEY
  }).toString();
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || !data.items || data.items.length === 0) return false;
  const item = data.items[0];
  return item.snippet.liveBroadcastContent === 'live' ||
    (item.liveStreamingDetails && item.liveStreamingDetails.actualStartTime && !item.liveStreamingDetails.actualEndTime);
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/websub')) {
    if (req.method === 'GET') {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const challenge = url.searchParams.get('hub.challenge');
      if (challenge) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(challenge);
      } else {
        res.writeHead(400);
        res.end();
      }
    } else if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        const idMatch = body.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
        const channelMatch = body.match(/<yt:channelId>([^<]+)<\/yt:channelId>/);
        if (idMatch && channelMatch) {
          const id = idMatch[1];
          const channelId = channelMatch[1];
          try {
            const live = await checkVideoLive(id);
            if (live) {
              console.log('Live stream detected from', channelId, ':', `https://www.youtube.com/watch?v=${id}`);
            } else {
              console.log('New video but not live from', channelId, ':', id);
            }
          } catch (err) {
            console.error('Error verifying video', err);
          }
        }
        res.writeHead(204);
        res.end();
      });
    } else {
      res.writeHead(405);
      res.end();
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
  subscribeAll().catch(err => console.error('Subscription setup failed', err));
});
