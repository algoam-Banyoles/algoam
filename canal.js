// Multiview — detecció i reproducció automàtica de directes sense API de Google.
// Tota la detecció es fa via redirecció /live + scrape HTML públic.

const CORS_PROXY = window.APP_CONFIG?.CORS_PROXY || 'https://corsproxy.io/?';

const CACHE_TTL = 5 * 60 * 1000;
const CACHE_KEY = 'liveCache';
const RESCAN_INTERVAL_MS = 90 * 1000;

const activeSet = new Set();
const stoppedSet = new Set();
const playerByKey = new Map();

let progressDone = 0;
let progressTotal = 0;

function loadCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
  } catch (_) {
    return {};
  }
}

function saveCache(cache) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

async function getChannels() {
  const response = await fetch('canals.json');
  return response.json();
}

function channelKey(ch) {
  return ch.channelId || ch.handle || ch.name;
}

function colorForName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 35%)`;
}

function placeholderHTML(name) {
  const letter = (name || '?').trim().charAt(0).toUpperCase();
  return `<div class="placeholder" style="background:${colorForName(name)}">${letter}</div>`;
}

function renderChannelCards(channels) {
  const root = document.getElementById('channelCards');
  if (!root) return;
  const cache = loadCache();
  root.innerHTML = '';
  for (const ch of channels) {
    const key = channelKey(ch);
    const card = document.createElement('article');
    card.className = 'ch-card';
    card.dataset.key = key;
    card.dataset.status = 'checking';
    const cached = cache[key];
    const initialThumb = cached?.videoId
      ? `<img loading="lazy" src="https://i.ytimg.com/vi/${cached.videoId}/hqdefault.jpg" alt="">`
      : placeholderHTML(ch.name);
    card.innerHTML = `
      <div class="ch-thumb">${initialThumb}<span class="ch-badge">EN DIRECTE</span></div>
      <h3 class="ch-name">${ch.name}</h3>
      <p class="ch-title"></p>
    `;
    card.addEventListener('click', () => {
      if (card.dataset.status !== 'live') return;
      const vid = card.dataset.videoId;
      if (!vid) return;
      if (activeSet.has(key)) return;
      stoppedSet.delete(key);
      addPlayer(vid, ch.name, key);
    });
    root.appendChild(card);
  }
}

function updateCard(result) {
  const card = document.querySelector(`.ch-card[data-key="${CSS.escape(result.key)}"]`);
  if (!card) return;
  if (result.live && result.videoId) {
    card.dataset.status = 'live';
    card.dataset.videoId = result.videoId;
    const thumbDiv = card.querySelector('.ch-thumb');
    const existingImg = thumbDiv.querySelector('img');
    const url = `https://i.ytimg.com/vi/${result.videoId}/hqdefault.jpg`;
    if (existingImg) {
      existingImg.src = url;
    } else {
      thumbDiv.innerHTML = `<img loading="lazy" src="${url}" alt=""><span class="ch-badge">EN DIRECTE</span>`;
    }
    card.querySelector('.ch-title').textContent = result.title || '';
  } else {
    card.dataset.status = 'offline';
    card.querySelector('.ch-title').textContent = '';
  }
}

function markCardError(channel) {
  const key = channelKey(channel);
  const card = document.querySelector(`.ch-card[data-key="${CSS.escape(key)}"]`);
  if (card) card.dataset.status = 'error';
}

function bumpProgressTotal(n) {
  progressDone = 0;
  progressTotal = n;
  renderProgress();
}

function bumpProgress() {
  progressDone++;
  renderProgress();
}

function renderProgress() {
  const el = document.getElementById('checkProgress');
  if (!el) return;
  if (progressDone >= progressTotal) {
    el.textContent = `${progressTotal} canals comprovats`;
  } else {
    el.textContent = `Comprovant ${progressDone}/${progressTotal}…`;
  }
}

let ytReadyPromise;
function whenYTReady() {
  if (ytReadyPromise) return ytReadyPromise;
  ytReadyPromise = new Promise(resolve => {
    if (window.YT && window.YT.Player) return resolve();
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prev === 'function') try { prev(); } catch (_) {}
      resolve();
    };
  });
  return ytReadyPromise;
}

function updateVideoHeight() {
  const container = document.getElementById('video-container');
  if (!container) return;
  const n = container.children.length;
  let h;
  if (n <= 1) h = 'min(80vh, 600px)';
  else if (n <= 2) h = '40vh';
  else if (n <= 4) h = '30vh';
  else if (n <= 6) h = '26vh';
  else h = '22vh';
  container.style.setProperty('--video-height', h);
}

let playerSeq = 0;
async function addPlayer(videoId, name, key) {
  if (activeSet.has(key)) return;
  await whenYTReady();
  const container = document.getElementById('video-container');
  if (!container) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'video-wrapper card z-depth-2';
  wrapper.dataset.key = key;

  const playerId = `player-${++playerSeq}`;
  const playerDiv = document.createElement('div');
  playerDiv.id = playerId;
  wrapper.appendChild(playerDiv);

  const stopBtn = document.createElement('button');
  stopBtn.className = 'stop-btn';
  stopBtn.title = 'Aturar reproductor';
  stopBtn.textContent = '×';
  stopBtn.addEventListener('click', () => stopPlayer(key));
  wrapper.appendChild(stopBtn);

  const nameEl = document.createElement('div');
  nameEl.className = 'player-name';
  nameEl.textContent = name;
  wrapper.appendChild(nameEl);

  container.appendChild(wrapper);
  activeSet.add(key);
  updateVideoHeight();

  const player = new YT.Player(playerId, {
    height: '250',
    width: '100%',
    videoId,
    playerVars: { autoplay: 1, mute: 1, playsinline: 1, controls: 1 },
  });
  playerByKey.set(key, { player, wrapper });
}

function stopPlayer(key) {
  const entry = playerByKey.get(key);
  if (!entry) return;
  try { entry.player.destroy(); } catch (_) {}
  entry.wrapper.remove();
  playerByKey.delete(key);
  activeSet.delete(key);
  stoppedSet.add(key);
  updateVideoHeight();
}

function autoPlay(result) {
  if (!result?.live || !result.videoId) return;
  if (activeSet.has(result.key) || stoppedSet.has(result.key)) return;
  addPlayer(result.videoId, result.name, result.key);
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

async function checkOneChannel(channel) {
  const key = channelKey(channel);
  const cache = loadCache();
  const now = Date.now();

  const cached = cache[key];
  if (cached && now - cached.ts < CACHE_TTL) {
    return {
      key,
      name: channel.name,
      videoId: cached.videoId || null,
      title: cached.title || '',
      thumb: cached.videoId ? `https://i.ytimg.com/vi/${cached.videoId}/hqdefault.jpg` : null,
      live: !!cached.videoId,
    };
  }

  const paths = [];
  if (channel.handle) paths.push(`https://www.youtube.com/${channel.handle}/live`);
  if (channel.channelId) paths.push(`https://www.youtube.com/channel/${channel.channelId}/live`);

  let parsed = null;
  for (const livePath of paths) {
    const proxyUrl = `${CORS_PROXY}${livePath}`;
    try {
      const res = await fetch(proxyUrl, { redirect: 'follow' });
      if (!res.ok) continue;
      const html = await res.text();
      parsed = parseLiveHtml(html);
      if (parsed) break;
    } catch (err) {
      console.warn(`fetch failed for ${livePath}`, err);
    }
  }

  const live = !!(parsed && parsed.videoId && parsed.isLive);
  const result = {
    key,
    name: channel.name,
    videoId: live ? parsed.videoId : null,
    title: live ? parsed.title : '',
    thumb: live ? `https://i.ytimg.com/vi/${parsed.videoId}/hqdefault.jpg` : null,
    live,
  };

  cache[key] = { ts: now, videoId: result.videoId, title: result.title };
  saveCache(cache);
  return result;
}

async function checkAllChannels() {
  const channels = await getChannels();
  bumpProgressTotal(channels.length);
  await Promise.allSettled(
    channels.map(ch =>
      checkOneChannel(ch)
        .then(result => {
          updateCard(result);
          if (result.live) autoPlay(result);
        })
        .catch(err => {
          console.warn('channel check failed', ch.name, err);
          markCardError(ch);
        })
        .finally(() => bumpProgress())
    )
  );
}

function startRescanLoop() {
  setInterval(() => {
    checkAllChannels().catch(err => console.warn('rescan failed', err));
  }, RESCAN_INTERVAL_MS);
}

function bindFilter() {
  const cb = document.getElementById('onlyLive');
  if (!cb) return;
  cb.addEventListener('change', () => {
    document.body.classList.toggle('only-live', cb.checked);
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  bindFilter();
  const channels = await getChannels();
  renderChannelCards(channels);
  await checkAllChannels();
  startRescanLoop();
});
