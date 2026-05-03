// Multiview — selector i reproducció de directes sense API de Google.
// Detecció via /streams + scrape HTML (CORS proxy). Un canal pot tenir
// múltiples directes simultanis: en sortirà una targeta per stream.
// Selecció manual persistida a localStorage (per videoId).

const CORS_PROXY = window.APP_CONFIG?.CORS_PROXY || 'https://api.codetabs.com/v1/proxy?quest=';

const CACHE_TTL = 5 * 60 * 1000;
const CACHE_KEY = 'liveCacheV6';
const SELECTED_KEY = 'selectedStreams';
const RESCAN_INTERVAL_MS = 90 * 1000;
const FETCH_CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 15000;

// Identificador estable que un usuari pot seleccionar:
//   - Per un stream live: el videoId (canvia quan canvia l'emissió)
//   - Per un canal offline o en comprovació: la channelKey (channelId o handle)
// La selecció és sempre per videoId; channelKey s'usa només a la UI per
// representar canals que encara no estan en directe.
const selectedSet = loadSelected();
const playerByKey = new Map();   // videoId -> {wrapper, player}
const channelByKey = new Map();  // channelKey -> channel object
const cardsByChannel = new Map(); // channelKey -> Set<cardKey>

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

function createCard({ cardKey, channel, status, videoId, title }) {
  const card = document.createElement('article');
  card.className = 'ch-card';
  card.dataset.key = cardKey;
  card.dataset.channelKey = channelKey(channel);
  card.dataset.status = status;
  card.dataset.selected = selectedSet.has(cardKey) ? 'true' : 'false';
  if (videoId) card.dataset.videoId = videoId;
  const thumb = videoId
    ? `<img loading="lazy" src="https://i.ytimg.com/vi/${videoId}/hqdefault.jpg" alt="">`
    : placeholderHTML(channel.name);
  card.innerHTML = `
    <div class="ch-thumb">
      ${thumb}
      <span class="ch-badge ch-badge-live">EN DIRECTE</span>
      <span class="ch-badge ch-badge-selected">✓ SELECCIONAT</span>
    </div>
    <h3 class="ch-name">${channel.name}</h3>
    <p class="ch-title">${title || ''}</p>
  `;
  card.addEventListener('click', () => onCardClick(cardKey));
  return card;
}

function renderChannelCards(channels) {
  const root = document.getElementById('channelCards');
  if (!root) return;
  const cache = loadCache();
  root.innerHTML = '';
  cardsByChannel.clear();
  for (const ch of channels) {
    const cKey = channelKey(ch);
    channelByKey.set(cKey, ch);
    const cached = cache[cKey];
    const cachedStreams = cached?.streams || [];
    if (cachedStreams.length > 0) {
      // Restore cards from cache (will get refreshed when checkAllChannels runs)
      const set = new Set();
      for (const s of cachedStreams) {
        const card = createCard({
          cardKey: s.videoId,
          channel: ch,
          status: 'live',
          videoId: s.videoId,
          title: s.title,
        });
        root.appendChild(card);
        set.add(s.videoId);
      }
      cardsByChannel.set(cKey, set);
    } else {
      const card = createCard({ cardKey: cKey, channel: ch, status: 'checking' });
      root.appendChild(card);
      cardsByChannel.set(cKey, new Set([cKey]));
    }
  }
}

function updateChannelCards(result) {
  const ch = channelByKey.get(result.key);
  if (!ch) return;
  const root = document.getElementById('channelCards');
  if (!root) return;

  const existing = cardsByChannel.get(result.key) || new Set();
  const streams = result.streams || [];

  if (streams.length === 0) {
    // Collapse to one offline card keyed by channelKey
    if (existing.size === 1 && existing.has(result.key)) {
      const card = root.querySelector(`.ch-card[data-key="${CSS.escape(result.key)}"]`);
      if (card) {
        card.dataset.status = result.error ? 'error' : 'offline';
        card.querySelector('.ch-title').textContent = '';
        card.removeAttribute('data-video-id');
      }
    } else {
      removeCardsByKeys(existing, root);
      const card = createCard({
        cardKey: result.key,
        channel: ch,
        status: result.error ? 'error' : 'offline',
      });
      root.appendChild(card);
      cardsByChannel.set(result.key, new Set([result.key]));
    }
    return;
  }

  // streams.length >= 1: one card per stream, keyed by videoId
  const desiredKeys = new Set(streams.map(s => s.videoId));

  // Remove obsolete cards (channel-key placeholder or ended streams)
  for (const k of existing) {
    if (!desiredKeys.has(k)) {
      const card = root.querySelector(`.ch-card[data-key="${CSS.escape(k)}"]`);
      if (card) card.remove();
    }
  }

  // Add or update cards for each current stream
  for (const stream of streams) {
    const card = root.querySelector(`.ch-card[data-key="${CSS.escape(stream.videoId)}"]`);
    if (card) {
      card.dataset.status = 'live';
      card.dataset.videoId = stream.videoId;
      card.querySelector('.ch-title').textContent = stream.title || '';
    } else {
      const newCard = createCard({
        cardKey: stream.videoId,
        channel: ch,
        status: 'live',
        videoId: stream.videoId,
        title: stream.title,
      });
      root.appendChild(newCard);
    }
  }

  cardsByChannel.set(result.key, desiredKeys);
}

function removeCardsByKeys(keys, root) {
  for (const k of keys) {
    const card = root.querySelector(`.ch-card[data-key="${CSS.escape(k)}"]`);
    if (card) card.remove();
  }
}

function markChannelError(channel) {
  updateChannelCards({ key: channelKey(channel), streams: [], error: true });
}

function onCardClick(cardKey) {
  const card = document.querySelector(`.ch-card[data-key="${CSS.escape(cardKey)}"]`);
  if (!card) return;
  if (selectedSet.has(cardKey)) {
    deselectStream(cardKey);
  } else {
    if (card.dataset.status !== 'live') return;
    selectStream(cardKey);
  }
}

function selectStream(videoId) {
  const card = document.querySelector(`.ch-card[data-key="${CSS.escape(videoId)}"]`);
  if (!card) return;
  const channelKeyVal = card.dataset.channelKey;
  const ch = channelByKey.get(channelKeyVal);
  if (!ch) return;
  selectedSet.add(videoId);
  saveSelected();
  card.dataset.selected = 'true';
  addPlayer(videoId, ch.name, videoId);
}

function deselectStream(videoId) {
  selectedSet.delete(videoId);
  saveSelected();
  const card = document.querySelector(`.ch-card[data-key="${CSS.escape(videoId)}"]`);
  if (card) card.dataset.selected = 'false';
  removePlayer(videoId);
  if (playerByKey.size === 0 && getActiveTab() === 'players') {
    switchTab('channels');
  }
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
  // es dupliqui un mateix vídeo si addPlayer s'invoca dues vegades de pressa.
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
  overlay.querySelector('.stop-btn').addEventListener('click', () => deselectStream(key));
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

// ---------- Detection (parses /streams page) ----------

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
    for (const key of Object.keys(obj)) {
      if (key === 'videoRenderer' || key === 'gridVideoRenderer') continue;
      walkVideoRenderers(obj[key], cb);
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
    const title = vr.title?.runs?.[0]?.text || vr.title?.simpleText || '';
    streams.push({ videoId: vr.videoId, title });
  });
  return streams;
}

async function checkOneChannel(channel) {
  const key = channelKey(channel);
  const cache = loadCache();
  const now = Date.now();

  const cached = cache[key];
  if (cached && now - cached.ts < CACHE_TTL) {
    return { key, name: channel.name, streams: cached.streams || [] };
  }

  const paths = [];
  if (channel.handle) paths.push(`https://www.youtube.com/${channel.handle}/streams`);
  if (channel.channelId) paths.push(`https://www.youtube.com/channel/${channel.channelId}/streams`);

  let streams = [];
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
      const ytData = extractYtInitialData(html);
      if (!ytData) continue;
      streams = findLiveStreams(ytData);
      break;
    } catch (err) {
      console.warn(`fetch failed for ${livePath}`, err.name || err);
    } finally {
      clearTimeout(timer);
    }
  }

  cache[key] = { ts: now, streams };
  saveCache(cache);
  return { key, name: channel.name, streams };
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
      updateChannelCards(result);
      maybeRestoreSelected(result);
    } catch (err) {
      console.warn('channel check failed', ch.name, err);
      markChannelError(ch);
    } finally {
      bumpProgress();
    }
  });
  sortCards();
}

function maybeRestoreSelected(result) {
  for (const stream of result.streams || []) {
    if (!selectedSet.has(stream.videoId)) continue;
    if (playerByKey.has(stream.videoId)) continue;
    addPlayer(stream.videoId, result.name, stream.videoId);
  }
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
