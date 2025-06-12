const http = require('http');

const { URL, URLSearchParams } = require('url');

const PORT = process.env.PORT || 3000;
const CALLBACK_URL = process.env.CALLBACK_URL || 'http://localhost:' + PORT + '/websub';
const CHANNEL_ID = process.env.CHANNEL_ID;
const API_KEY = process.env.API_KEY;

if (!CHANNEL_ID) {
  console.error('Missing CHANNEL_ID environment variable');
  process.exit(1);
}

if (!API_KEY) {
  console.error('Missing API_KEY environment variable');
  process.exit(1);
}


async function subscribe() {
  const hubUrl = 'https://pubsubhubbub.appspot.com/subscribe';
  const topic = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${CHANNEL_ID}`;


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


    console.log('Subscribed to WebSub hub');
  } else {
    console.error('Failed to subscribe', res.status, await res.text());


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


        const match = body.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
        if (match) {
          const id = match[1];
          try {
            const live = await checkVideoLive(id);
            if (live) {
              console.log('Live stream detected:', `https://www.youtube.com/watch?v=${id}`);
            } else {
              console.log('New video but not live:', id);


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


  subscribe().catch(err => console.error('Subscription failed', err));


});
