// Cloudflare Worker: backend for Multiview push notifications + shared
// "all-live" snapshot for the PWA.
//
// Heavy work (scraping ~80 YouTube /streams pages every 5 min) lives in
// GitHub Actions: a Node script fetches them all and POSTs the aggregated
// state here. The worker only diffs against the previous KV state, fires
// Web Pushes for newly-live videoIds, and serves the snapshot back to the
// PWA so it doesn't need to re-scrape from the browser.
//
// Endpoints:
//   GET  /vapid-public       -> {key}
//   GET  /all-live           -> {ts, channels:[{channelKey,name,streams}]}
//   POST /subscribe          -> body {subscription, channels:[]}
//   POST /unsubscribe        -> body {endpoint}
//   POST /update-channels    -> body {endpoint, channels:[]}
//   POST /poll  (auth)       -> body {channels:[{channelKey,name,streams:[{videoId,title}]}]}
//                                stores state, sends pushes for new lives
//
// KV layout:
//   sub:<sha256(endpoint)>   -> {endpoint,keys,channels:[channelKey],ts}
//   live:state               -> {ts, channels:{channelKey:{name,streams}}}

import webpush from 'web-push';

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

async function subKey(endpoint) {
  return `sub:${await sha256Hex(endpoint)}`;
}

function setupWebPush(env) {
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC, env.VAPID_PRIVATE);
}

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

// ---------- Push diff and dispatch ----------

async function ingestPoll(env, payload) {
  // payload: { channels: [{channelKey, name, streams:[{videoId, title}]}] }
  if (!payload || !Array.isArray(payload.channels)) {
    return { error: 'invalid payload' };
  }

  setupWebPush(env);

  const previous = (await env.ALGOAM_KV.get('live:state', 'json')) || { channels: {} };
  const previousByKey = previous.channels || {};
  const subs = await listAllSubs(env);

  const newState = { ts: Date.now(), channels: {} };
  let pushesSent = 0;

  for (const ch of payload.channels) {
    if (!ch?.channelKey) continue;
    const streams = Array.isArray(ch.streams) ? ch.streams : [];
    newState.channels[ch.channelKey] = {
      name: ch.name || ch.channelKey,
      streams,
    };

    const prevIds = new Set((previousByKey[ch.channelKey]?.streams || []).map(s => s.videoId));
    const newOnes = streams.filter(s => s.videoId && !prevIds.has(s.videoId));
    if (newOnes.length === 0) continue;

    // Find subscribers wanting this channel
    const subscribers = subs.filter(s => (s.channels || []).includes(ch.channelKey));
    if (subscribers.length === 0) continue;

    for (const stream of newOnes) {
      const data = JSON.stringify({
        channel: ch.name || ch.channelKey,
        channelKey: ch.channelKey,
        videoId: stream.videoId,
        title: stream.title || '',
      });
      for (const sub of subscribers) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: sub.keys },
            data,
            { TTL: 600 },
          );
          pushesSent++;
        } catch (err) {
          const code = err?.statusCode;
          if (code === 404 || code === 410) {
            await deleteSub(env, sub.kvKey);
          } else {
            console.error('push failed', code, err?.body || err?.message);
          }
        }
      }
    }
  }

  await env.ALGOAM_KV.put('live:state', JSON.stringify(newState));
  return { ok: true, channels: payload.channels.length, pushes: pushesSent };
}

// ---------- Router ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method === 'GET' && url.pathname === '/vapid-public') {
      return json({ key: env.VAPID_PUBLIC }, {}, origin);
    }

    if (request.method === 'GET' && url.pathname === '/all-live') {
      const state = (await env.ALGOAM_KV.get('live:state', 'json')) || { ts: 0, channels: {} };
      // Convert object map to array for stable client consumption
      const channels = Object.entries(state.channels || {}).map(([channelKey, v]) => ({
        channelKey,
        name: v.name,
        streams: v.streams || [],
      }));
      return json({ ts: state.ts || 0, channels }, {}, origin);
    }

    if (request.method === 'POST' && url.pathname === '/subscribe') {
      const body = await request.json().catch(() => null);
      if (!body?.subscription?.endpoint) return json({ error: 'bad request' }, { status: 400 }, origin);
      const k = await subKey(body.subscription.endpoint);
      await env.ALGOAM_KV.put(k, JSON.stringify({
        endpoint: body.subscription.endpoint,
        keys: body.subscription.keys,
        channels: Array.from(new Set(body.channels || [])),
        ts: Date.now(),
      }));
      return json({ ok: true }, {}, origin);
    }

    if (request.method === 'POST' && url.pathname === '/unsubscribe') {
      const body = await request.json().catch(() => null);
      if (!body?.endpoint) return json({ error: 'bad request' }, { status: 400 }, origin);
      await env.ALGOAM_KV.delete(await subKey(body.endpoint));
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
      const body = await request.json().catch(() => null);
      try {
        const result = await ingestPoll(env, body);
        return json(result, {}, origin);
      } catch (err) {
        return json({ error: err?.message || 'poll failed' }, { status: 500 }, origin);
      }
    }

    return json({ error: 'not found' }, { status: 404 }, origin);
  },
};
