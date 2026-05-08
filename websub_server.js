/*!
 * Billar en Directe
 * Copyright (c) 2026 Albert Gómez
 * Desenvolupat amb Claude (Anthropic) — https://claude.com/claude-code
 */

// Servidor WebSub/PubSubHubbub per a notificacions push de canals YouTube.
// Es manté com a referència — la PWA no en depèn. La verificació de directe
// es fa via scrape públic (sense API de Google).

const http = require('http');
const { URL, URLSearchParams } = require('url');

const PORT = process.env.PORT || 3000;
const CALLBACK_URL = process.env.CALLBACK_URL || 'http://localhost:' + PORT + '/websub';
const CHANNEL_ID = process.env.CHANNEL_ID;

if (!CHANNEL_ID) {
  console.error('Missing CHANNEL_ID environment variable');
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
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie': 'CONSENT=YES+1',
    },
  });
  if (!res.ok) return false;
  const html = await res.text();
  if (/"isUpcoming":true/.test(html)) return false;
  return /"isLive":true/.test(html);
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
