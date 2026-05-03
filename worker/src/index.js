// Cloudflare Worker: backend for Multiview push notifications.
// Endpoints:
//   GET  /vapid-public          -> returns the VAPID public key (base64url)
//   POST /subscribe             -> body {subscription, channels:[]}; stores
//   POST /unsubscribe           -> body {endpoint}; removes from KV
//   POST /update-channels       -> body {endpoint, channels:[]}; replaces list
//   POST /poll  (auth)          -> polls /streams of subscribed channels and
//                                  sends a push for any new live videoId
//
// KV layout:
//   sub:<sha256(endpoint)>  -> {endpoint, keys, channels:[channelKey]}
//   state:<channelKey>      -> [videoId, ...]   (last seen live ids)
//
// Auth for /poll: shared secret in `Authorization: Bearer <POLL_SECRET>`.

import webpush from 'web-push';

// ---------- Helpers ----------

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, init = {}, origin) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin), ...(init.headers || {}) },
  });
}

async function sha256Hex(s) {
  const data = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function subKey(endpoint) {
  // Async caller resolves; here we return a promise wrapper.
  return sha256Hex(endpoint).then(h => `sub:${h}`);
}

function setupWebPush(env) {
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC, env.VAPID_PRIVATE);
}

// ---------- Stream detection (mirrors canal.js) ----------

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
    for (const k of Object.keys(obj)) {
      if (k === 'videoRenderer' || k === 'gridVideoRenderer') continue;
      walkVideoRenderers(obj[k], cb);
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
    streams.push({
      videoId: vr.videoId,
      title: vr.title?.runs?.[0]?.text || vr.title?.simpleText || '',
    });
  });
  return streams;
}

async function fetchChannelLive(channel) {
  const paths = [];
  if (channel.handle) paths.push(`https://www.youtube.com/${channel.handle}/streams`);
  if (channel.channelId) paths.push(`https://www.youtube.com/channel/${channel.channelId}/streams`);
  for (const p of paths) {
    try {
      const res = await fetch(p, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AlgoamBot/1.0)',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cookie': 'CONSENT=YES+1',
        },
      });
      if (!res.ok) continue;
      const html = await res.text();
      const ytData = extractYtInitialData(html);
      if (!ytData) continue;
      const streams = findLiveStreams(ytData);
      return streams;
    } catch (_) { /* try next */ }
  }
  return [];
}

// ---------- Subscription storage ----------

async function listAllSubs(env) {
  const list = await env.ALGOAM_KV.list({ prefix: 'sub:' });
  const subs = [];
  for (const k of list.keys) {
    const value = await env.ALGOAM_KV.get(k.name, 'json');
    if (value) subs.push({ kvKey: k.name, ...value });
  }
  return subs;
}

async function deleteSub(env, kvKey) {
  await env.ALGOAM_KV.delete(kvKey);
}

// ---------- Channel manifest ----------

const CHANNELS_URL = (env) =>
  env.CHANNELS_URL || 'https://raw.githubusercontent.com/algoam-Banyoles/algoam/main/canals.json';

async function loadChannels(env) {
  const cached = await env.ALGOAM_KV.get('channels:cache', 'json');
  const now = Date.now();
  if (cached && now - cached.ts < 30 * 60 * 1000) return cached.data;
  const res = await fetch(CHANNELS_URL(env));
  const data = await res.json();
  await env.ALGOAM_KV.put('channels:cache', JSON.stringify({ ts: now, data }), {
    expirationTtl: 3600,
  });
  return data;
}

function channelKey(ch) {
  return ch.channelId || ch.handle || ch.name;
}

// ---------- Polling ----------

async function pollOnce(env) {
  setupWebPush(env);
  const channels = await loadChannels(env);
  const subs = await listAllSubs(env);
  if (subs.length === 0) return { subs: 0, polled: 0, pushes: 0 };

  // Build set of channelKeys that at least one subscriber wants
  const wantedKeys = new Set();
  for (const s of subs) {
    for (const ck of s.channels || []) wantedKeys.add(ck);
  }
  if (wantedKeys.size === 0) return { subs: subs.length, polled: 0, pushes: 0 };

  const channelByKey = new Map();
  for (const ch of channels) channelByKey.set(channelKey(ch), ch);

  let polled = 0;
  let pushes = 0;
  const pollTargets = [...wantedKeys].filter(k => channelByKey.has(k));

  // Poll all wanted channels (sequentially to be friendly)
  for (const ck of pollTargets) {
    const ch = channelByKey.get(ck);
    polled++;
    const streams = await fetchChannelLive(ch);
    const currentIds = streams.map(s => s.videoId).sort();
    const stateKey = `state:${ck}`;
    const prev = (await env.ALGOAM_KV.get(stateKey, 'json')) || [];
    const prevSet = new Set(prev);
    const newOnes = streams.filter(s => !prevSet.has(s.videoId));

    if (newOnes.length > 0) {
      const subscribers = subs.filter(s => (s.channels || []).includes(ck));
      for (const stream of newOnes) {
        const payload = JSON.stringify({
          channel: ch.name,
          channelKey: ck,
          videoId: stream.videoId,
          title: stream.title,
        });
        for (const sub of subscribers) {
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: sub.keys },
              payload,
              { TTL: 600 },
            );
            pushes++;
          } catch (err) {
            const code = err?.statusCode;
            if (code === 404 || code === 410) {
              // expired subscription
              await deleteSub(env, sub.kvKey);
            } else {
              console.error('push failed', code, err?.body || err?.message);
            }
          }
        }
      }
    }

    await env.ALGOAM_KV.put(stateKey, JSON.stringify(currentIds), {
      expirationTtl: 7 * 24 * 3600,
    });
  }

  return { subs: subs.length, polled, pushes };
}

// ---------- Request router ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method === 'GET' && url.pathname === '/vapid-public') {
      return json({ key: env.VAPID_PUBLIC }, {}, origin);
    }

    if (request.method === 'POST' && url.pathname === '/subscribe') {
      const body = await request.json().catch(() => null);
      if (!body?.subscription?.endpoint) return json({ error: 'bad request' }, { status: 400 }, origin);
      const { subscription, channels = [] } = body;
      const k = await subKey(subscription.endpoint);
      await env.ALGOAM_KV.put(k, JSON.stringify({
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        channels: Array.from(new Set(channels)),
        ts: Date.now(),
      }));
      return json({ ok: true }, {}, origin);
    }

    if (request.method === 'POST' && url.pathname === '/unsubscribe') {
      const body = await request.json().catch(() => null);
      if (!body?.endpoint) return json({ error: 'bad request' }, { status: 400 }, origin);
      const k = await subKey(body.endpoint);
      await env.ALGOAM_KV.delete(k);
      return json({ ok: true }, {}, origin);
    }

    if (request.method === 'POST' && url.pathname === '/update-channels') {
      const body = await request.json().catch(() => null);
      if (!body?.endpoint) return json({ error: 'bad request' }, { status: 400 }, origin);
      const k = await subKey(body.endpoint);
      const existing = await env.ALGOAM_KV.get(k, 'json');
      if (!existing) return json({ error: 'not subscribed' }, { status: 404 }, origin);
      existing.channels = Array.from(new Set(body.channels || []));
      existing.ts = Date.now();
      if (existing.channels.length === 0) {
        await env.ALGOAM_KV.delete(k);
      } else {
        await env.ALGOAM_KV.put(k, JSON.stringify(existing));
      }
      return json({ ok: true }, {}, origin);
    }

    if (request.method === 'POST' && url.pathname === '/poll') {
      const auth = request.headers.get('Authorization') || '';
      if (auth !== `Bearer ${env.POLL_SECRET}`) {
        return json({ error: 'unauthorized' }, { status: 401 }, origin);
      }
      try {
        const result = await pollOnce(env);
        return json(result, {}, origin);
      } catch (err) {
        return json({ error: err?.message || 'poll failed' }, { status: 500 }, origin);
      }
    }

    return json({ error: 'not found' }, { status: 404 }, origin);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollOnce(env).catch(err => console.error('scheduled poll', err)));
  },
};
