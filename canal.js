// Multiview — selector i reproducció de directes sense API de Google.
// Detecció via fetch + scrape HTML (CORS proxy). Selecció manual; iframes
// a la pestanya "Reproducció". Selecció persistida a localStorage.

// codetabs entrega les pàgines /live de YouTube sense LOGIN_REQUIRED;
// corsproxy.io rep LOGIN_REQUIRED per als canals en directe (IP bloquejada).
const CORS_PROXY = window.APP_CONFIG?.CORS_PROXY || 'https://api.codetabs.com/v1/proxy?quest=';

const CACHE_TTL = 5 * 60 * 1000;
const CACHE_KEY = 'liveCacheV5';
const SELECTED_KEY = 'selectedChannels';
const RESCAN_INTERVAL_MS = 90 * 1000;
const FETCH_CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 15000;

const selectedSet = loadSelected();
const playerByKey = new Map();
const channelByKey = new Map();

let progressDone = 0;
let progressTotal = 0;
let playerSeq = 0;

function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; }
  catch (_) { return {}; }
}

function saveCache(cache) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

function loadSelected() {
  try { return new Set(JSON.parse(localStorage.getItem(SELECTED_KEY)) || []); }
  catch (_) { return new Set(); }
}

function saveSelected() {
  localStorage.setItem(SELECTED_KEY, JSON.stringify(Array.from(selectedSet)));
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
  return `hsl(${Math.abs(hash) % 360}, 55%, 35%)`;
}

function placeholderHTML(name) {
  const letter = (name || '?').trim().charAt(0).toUpperCase();
  return `<div class="placeholder" style="background:${colorForName(name)}">${letter}</div>`;
}

// ---------- Channel cards ----------

function renderChannelCards(channels) {
  const root = document.getElementById('channelCards');
  if (!root) return;
  const cache = loadCache();
  root.innerHTML = '';
  for (const ch of channels) {
    const key = channelKey(ch);
    channelByKey.set(key, ch);
    const card = document.createElement('article');
    card.className = 'ch-card';
    card.dataset.key = key;
    card.dataset.status = 'checking';
    card.dataset.selected = selectedSet.has(key) ? 'true' : 'false';
    const cached = cache[key];
    const initialThumb = cached?.videoId
      ? `<img loading="lazy" src="https://i.ytimg.com/vi/${cached.videoId}/hqdefault.jpg" alt="">`
      : placeholderHTML(ch.name);
    card.innerHTML = `
      <div class="ch-thumb">
        ${initialThumb}
        <span class="ch-badge ch-badge-live">EN DIRECTE</span>
        <span class="ch-badge ch-badge-selected">✓ SELECCIONAT</span>
      </div>
      <h3 class="ch-name">${ch.name}</h3>
      <p class="ch-title"></p>
    `;
    card.addEventListener('click', () => onCardClick(key));
    root.appendChild(card);
  }
}

function onCardClick(key) {
  const card = document.querySelector(`.ch-card[data-key="${CSS.escape(key)}"]`);
  if (!card) return;
  if (selectedSet.has(key)) {
    deselectChannel(key);
  } else {
    if (card.dataset.status !== 'live') return;
    selectChannel(key);
  }
}

function selectChannel(key) {
  const card = document.querySelector(`.ch-card[data-key="${CSS.escape(key)}"]`);
  const ch = channelByKey.get(key);
  if (!ch) return;
  const cache = loadCache();
  const videoId = cache[key]?.videoId;
  if (!videoId) return;
  selectedSet.add(key);
  saveSelected();
  if (card) card.dataset.selected = 'true';
  addPlayer(videoId, ch.name, key);
}

function deselectChannel(key) {
  selectedSet.delete(key);
  saveSelected();
  const card = document.querySelector(`.ch-card[data-key="${CSS.escape(key)}"]`);
  if (card) card.dataset.selected = 'false';
  removePlayer(key);
  if (playerByKey.size === 0 && getActiveTab() === 'players') {
    switchTab('channels');
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
    if (existingImg) existingImg.src = url;
    else thumbDiv.insertAdjacentHTML('afterbegin', `<img loading="lazy" src="${url}" alt="">`);
    card.querySelector('.ch-title').textContent = result.title || '';
  } else {
    card.dataset.status = 'offline';
    card.querySelector('.ch-title').textContent = '';
  }
}

function markCardError(channel) {
  const key = channelKey(channel);
  const card = document.querySelector(`.ch-card[data-key="${CSS.escape(key)}"]`);
  if (card && card.dataset.status === 'checking') card.dataset.status = 'error';
}

function sortCards() {
  const root = document.getElementById('channelCards');
  if (!root) return;
  const order = { live: 0, checking: 1, error: 2, offline: 3 };
  const cards = Array.from(root.querySelectorAll('.ch-card'));
  cards.sort((a, b) => {
    const oa = order[a.dataset.status] ?? 9;
    const ob = order[b.dataset.status] ?? 9;
    if (oa !== ob) return oa - ob;
    return a.querySelector('.ch-name').textContent.localeCompare(
      b.querySelector('.ch-name').textContent
    );
  });
  cards.forEach(c => root.appendChild(c));
}

// ---------- Filters ----------

// Filtres via CSS (body.only-live + .search-hidden) perquè s'apliquin
// automàticament quan els data-status canvien sense haver de re-renderitzar.
function applyOnlyLiveFilter() {
  const cb = document.getElementById('onlyLive');
  document.body.classList.toggle('only-live', !!cb?.checked);
}

function applySearchFilter() {
  const input = document.getElementById('searchInput');
  const q = (input?.value || '').toLowerCase().trim();
  document.querySelectorAll('.ch-card').forEach(card => {
    const name = card.querySelector('.ch-name').textContent.toLowerCase();
    card.classList.toggle('search-hidden', !!q && !name.includes(q));
  });
}

// ---------- Progress ----------

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
  el.textContent = progressDone >= progressTotal
    ? `${progressTotal} canals comprovats`
    : `Comprovant ${progressDone}/${progressTotal}…`;
}

// ---------- YouTube IFrame API ----------

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

// ---------- Players ----------

function updateGridCols() {
  const container = document.getElementById('video-container');
  if (!container) return;
  const n = playerByKey.size;
  const isMobile = window.matchMedia('(max-width: 767px)').matches;
  let cols;
  if (isMobile) cols = 1;
  else if (n <= 1) cols = 1;
  else if (n === 2) cols = 2;
  else if (n <= 4) cols = 2;
  else if (n <= 9) cols = 3;
  else cols = 4;
  container.style.setProperty('--cols', cols);
}

async function addPlayer(videoId, name, key) {
  if (playerByKey.has(key)) return;
  // Reserva l'slot abans del await perquè el comptador sigui correcte i no
  // es dupliqui un mateix canal si addPlayer s'invoca dues vegades de pressa.
  const slot = { wrapper: null, player: null };
  playerByKey.set(key, slot);
  updatePlayerCount();

  await whenYTReady();
  const container = document.getElementById('video-container');
  if (!container) {
    playerByKey.delete(key);
    updatePlayerCount();
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'video-wrapper';
  wrapper.dataset.key = key;

  const playerId = `player-${++playerSeq}`;
  const playerDiv = document.createElement('div');
  playerDiv.id = playerId;
  playerDiv.className = 'player-iframe-host';
  wrapper.appendChild(playerDiv);

  const overlay = document.createElement('div');
  overlay.className = 'player-overlay';
  overlay.innerHTML = `
    <span class="player-name">${name}</span>
    <button class="stop-btn" title="Aturar reproductor">×</button>
  `;
  overlay.querySelector('.stop-btn').addEventListener('click', () => deselectChannel(key));
  wrapper.appendChild(overlay);

  container.appendChild(wrapper);
  slot.wrapper = wrapper;
  updateGridCols();

  slot.player = new YT.Player(playerId, {
    height: '100%',
    width: '100%',
    videoId,
    playerVars: { autoplay: 1, mute: 1, playsinline: 1, controls: 1 },
  });
}

function removePlayer(key) {
  const entry = playerByKey.get(key);
  if (!entry) return;
  try { entry.player?.destroy(); } catch (_) {}
  entry.wrapper?.remove();
  playerByKey.delete(key);
  updateGridCols();
  updatePlayerCount();
}

function updatePlayerCount() {
  const el = document.getElementById('playerCount');
  if (el) el.textContent = playerByKey.size > 0 ? `(${playerByKey.size})` : '';
}

// ---------- Tabs ----------

function getActiveTab() {
  const btn = document.querySelector('.tab-btn.active');
  return btn?.dataset.tab || 'channels';
}

function switchTab(name) {
  if (name === 'players' && playerByKey.size === 0) name = 'channels';
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name)
  );
  document.querySelectorAll('.tab-panel').forEach(p =>
    p.classList.toggle('active', p.id === `tab-${name}`)
  );
  document.body.dataset.activeTab = name;
}

// ---------- Detection ----------

// Extreu el JSON ytInitialPlayerResponse de l'HTML balancejant claus i
// respectant strings escapades. Cal evitar regex sobre 1MB perquè "isLive":true
// pot aparèixer en vídeos relacionats — només volem el del vídeo principal.
function extractInitialPlayerResponse(html) {
  const idx = html.indexOf('ytInitialPlayerResponse');
  if (idx < 0) return null;
  const startBrace = html.indexOf('{', idx);
  if (startBrace < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
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

// Detecció robusta: només acceptem si YouTube està servint segments ARA
// (streamingData.hlsManifestUrl o dashManifestUrl). Les emissions programades
// tenen videoDetails.isLive=true però NO tenen URL de manifest perquè cap
// segment s'està servint encara — així les descartem.
function parseLiveHtml(html) {
  const ipr = extractInitialPlayerResponse(html);
  if (!ipr) return null;
  const vd = ipr.videoDetails;
  if (!vd || !vd.videoId) return null;
  if (vd.isUpcoming === true) return null;
  if (vd.isLive !== true) return null;
  const lbd = ipr.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
  if (lbd && lbd.isLiveNow === false) return null;
  const sd = ipr.streamingData;
  const hasManifest =
    typeof sd?.hlsManifestUrl === 'string' && sd.hlsManifestUrl.startsWith('http') ||
    typeof sd?.dashManifestUrl === 'string' && sd.dashManifestUrl.startsWith('http');
  if (!hasManifest) return null;
  return { videoId: vd.videoId, isLive: true, title: vd.title || '' };
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
      live: !!cached.videoId,
    };
  }

  const paths = [];
  if (channel.handle) paths.push(`https://www.youtube.com/${channel.handle}/live`);
  if (channel.channelId) paths.push(`https://www.youtube.com/channel/${channel.channelId}/live`);

  let parsed = null;
  for (const livePath of paths) {
    const proxyUrl = `${CORS_PROXY}${encodeURIComponent(livePath)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(proxyUrl, {
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { 'Accept-Language': 'en-US,en;q=0.9' },
      });
      if (!res.ok) continue;
      const html = await res.text();
      parsed = parseLiveHtml(html);
      if (parsed && parsed.videoId && parsed.isLive) break;
      parsed = null;
    } catch (err) {
      console.warn(`fetch failed for ${livePath}`, err.name || err);
    } finally {
      clearTimeout(timer);
    }
  }

  const live = !!(parsed && parsed.videoId && parsed.isLive);
  const result = {
    key,
    name: channel.name,
    videoId: live ? parsed.videoId : null,
    title: live ? parsed.title : '',
    live,
  };

  cache[key] = { ts: now, videoId: result.videoId, title: result.title };
  saveCache(cache);
  return result;
}

async function pLimit(limit, items, fn) {
  let i = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        await fn(items[idx]);
      }
    }
  );
  await Promise.all(workers);
}

async function checkAllChannels() {
  const channels = Array.from(channelByKey.values());
  bumpProgressTotal(channels.length);
  await pLimit(FETCH_CONCURRENCY, channels, async ch => {
    try {
      const result = await checkOneChannel(ch);
      updateCard(result);
      maybeRestoreSelected(result);
    } catch (err) {
      console.warn('channel check failed', ch.name, err);
      markCardError(ch);
    } finally {
      bumpProgress();
    }
  });
  sortCards();
}

function maybeRestoreSelected(result) {
  if (!selectedSet.has(result.key)) return;
  if (!result.live || !result.videoId) return;
  if (playerByKey.has(result.key)) return;
  const ch = channelByKey.get(result.key);
  if (!ch) return;
  addPlayer(result.videoId, ch.name, result.key);
}

function startRescanLoop() {
  setInterval(() => {
    checkAllChannels().catch(err => console.warn('rescan failed', err));
  }, RESCAN_INTERVAL_MS);
}

// ---------- Init ----------

document.addEventListener('DOMContentLoaded', async () => {
  const channels = await getChannels();
  renderChannelCards(channels);

  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  );
  document.getElementById('searchInput')?.addEventListener('input', applySearchFilter);
  document.getElementById('onlyLive')?.addEventListener('change', applyOnlyLiveFilter);
  applyOnlyLiveFilter();
  window.addEventListener('resize', updateGridCols);

  switchTab(selectedSet.size > 0 ? 'players' : 'channels');
  updatePlayerCount();

  await checkAllChannels();
  startRescanLoop();
});
