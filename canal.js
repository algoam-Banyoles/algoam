// Billar en Directe — selector i reproducció de directes sense API de Google.
// Detecció via /streams + scrape HTML (CORS proxy). Un canal pot tenir
// múltiples directes simultanis: en sortirà una targeta per stream.
// Selecció manual persistida a localStorage (per videoId).

const CORS_PROXY = window.APP_CONFIG?.CORS_PROXY || 'https://api.codetabs.com/v1/proxy?quest=';
const WORKER_URL = window.APP_CONFIG?.WORKER_URL || '';
let vapidPublic = window.APP_CONFIG?.VAPID_PUBLIC || '';

const CACHE_TTL = 5 * 60 * 1000;
const CACHE_KEY = 'liveCacheV6';
const SELECTED_KEY = 'selectedStreams';
const PUSH_CHANNELS_KEY = 'pushChannels';
const RESCAN_INTERVAL_MS = 90 * 1000;
const FETCH_CONCURRENCY = 12;
const FETCH_TIMEOUT_MS = 15000;

// Sostre de reproductors simultanis. Cada YT IFrame descodifica vídeo i
// audio de forma independent: a partir d'un cert número, mòbils i equips
// modests perden frames o no acaben de carregar. Calculem un cap segons
// capacitat detectada; APP_CONFIG.MAX_PLAYERS el pot sobreescriure.
function computeMaxPlayers() {
  const override = Number(window.APP_CONFIG?.MAX_PLAYERS);
  if (Number.isFinite(override) && override > 0) return override;
  const isMobile = window.matchMedia('(max-width: 767px)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  // navigator.deviceMemory no està disponible a Safari/iOS; assumim 4 GB.
  const memGB = navigator.deviceMemory || 4;
  if (isMobile) {
    if (cores >= 6 && memGB >= 4) return 4;
    return 2;
  }
  if (cores >= 12 && memGB >= 16) return 16;
  if (cores >= 8 && memGB >= 8) return 12;
  if (cores >= 4) return 8;
  return 4;
}
const MAX_PLAYERS = computeMaxPlayers();

// Identificador estable que un usuari pot seleccionar:
//   - Per un stream live: el videoId (canvia quan canvia l'emissió)
//   - Per un canal offline o en comprovació: la channelKey (channelId o handle)
// La selecció és sempre per videoId; channelKey s'usa només a la UI per
// representar canals que encara no estan en directe.
const selectedSet = loadSelected();
const subscribedChannels = loadPushChannels();
const playerByKey = new Map();   // videoId -> {wrapper, player}
const channelByKey = new Map();  // channelKey -> channel object
const cardsByChannel = new Map(); // channelKey -> Set<cardKey>
const groupElByKey = new Map();  // groupKey (LIVE_GROUP_KEY | clubName) -> <details>
const federationGroupByKey = new Map(); // federationKey -> <details> (macro group)

const LIVE_GROUP_KEY = '__live__';
const LIVE_GROUP_LABEL = 'Ara en directe';
const OTHERS_FED_KEY = 'OTHERS';
const FEDERATION_LABELS = {
  FCB: 'Federació Catalana de Billar',
  RFEB: 'Federació Espanyola de Billar',
  [OTHERS_FED_KEY]: 'Internacionals',
};
// Ordre dels macro grups (live no compta, té el seu lloc fix al top).
const FEDERATION_ORDER = ['FCB', 'RFEB', OTHERS_FED_KEY];

// Ordre dels grups: live primer, Banyoles segon, resta alfabèticament.
function groupOrder(key) {
  if (key === LIVE_GROUP_KEY) return 0;
  if (/banyoles/i.test(key)) return 1;
  return 2;
}

function compareGroupKeys(a, b) {
  const oa = groupOrder(a);
  const ob = groupOrder(b);
  if (oa !== ob) return oa - ob;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

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

function loadPushChannels() {
  try { return new Set(JSON.parse(localStorage.getItem(PUSH_CHANNELS_KEY)) || []); }
  catch (_) { return new Set(); }
}

function savePushChannels() {
  localStorage.setItem(PUSH_CHANNELS_KEY, JSON.stringify(Array.from(subscribedChannels)));
}

async function getChannels() {
  const response = await fetch('canals.json');
  return response.json();
}

function channelKey(ch) {
  return ch.channelId || ch.handle || ch.name;
}

// Treu el sufix de mesa/taula ("CLUB X 1" -> "CLUB X", "PBA_1" -> "PBA").
// Mantén intacte el nom si no hi ha sufix numèric clar.
function clubNameFor(channel) {
  const name = channel.name || '';
  const stripped = name.replace(/[\s_]+\d+\s*$/, '').trim();
  return stripped || name;
}

function federationKey(channel) {
  return channel.federation || OTHERS_FED_KEY;
}

function youtubeChannelURL(ch) {
  if (ch.handle) {
    const h = ch.handle.startsWith('@') ? ch.handle : `@${ch.handle}`;
    return `https://www.youtube.com/${h}`;
  }
  if (ch.channelId) return `https://www.youtube.com/channel/${ch.channelId}`;
  return null;
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
  const cKey = channelKey(channel);
  card.dataset.channelKey = cKey;
  card.dataset.status = status;
  card.dataset.selected = selectedSet.has(cardKey) ? 'true' : 'false';
  card.dataset.notify = subscribedChannels.has(cKey) ? 'on' : 'off';
  if (videoId) card.dataset.videoId = videoId;
  const thumb = videoId
    ? `<img loading="lazy" src="https://i.ytimg.com/vi/${videoId}/hqdefault.jpg" alt="">`
    : placeholderHTML(channel.name);
  card.innerHTML = `
    <div class="ch-thumb">
      ${thumb}
      <span class="ch-badge ch-badge-live">EN DIRECTE</span>
      <span class="ch-badge ch-badge-selected">✓ SELECCIONAT</span>
      <button class="bell-btn" type="button"
              title="Notifica'm quan aquest canal entri en directe"
              aria-label="Activar notificacions">
        <span class="bell-on">🔔</span>
        <span class="bell-off">🔕</span>
      </button>
    </div>
    <h3 class="ch-name">${channel.name}</h3>
    <p class="ch-title">${title || ''}</p>
  `;
  card.addEventListener('click', () => onCardClick(cardKey));
  card.querySelector('.bell-btn').addEventListener('click', e => {
    e.stopPropagation();
    toggleBellForChannel(cKey);
  });
  return card;
}

function ensureFederationGroup(root, fed) {
  let el = federationGroupByKey.get(fed);
  if (el) return el;
  el = document.createElement('details');
  el.className = 'federation-group';
  el.dataset.federation = fed;
  el.open = true;
  el.innerHTML = `
    <summary>
      <span class="club-arrow" aria-hidden="true"></span>
      <span class="club-title"></span>
      <span class="club-count"></span>
    </summary>
    <div class="federation-children"></div>
  `;
  el.querySelector('.club-title').textContent = FEDERATION_LABELS[fed] || fed;
  federationGroupByKey.set(fed, el);

  // FCB just after Live; OTHERS after FCB; both before any other later element.
  const desiredIdx = FEDERATION_ORDER.indexOf(fed);
  const existing = Array.from(root.querySelectorAll(':scope > details.federation-group'));
  let inserted = false;
  for (const g of existing) {
    const gIdx = FEDERATION_ORDER.indexOf(g.dataset.federation);
    if (gIdx > desiredIdx) {
      root.insertBefore(el, g);
      inserted = true;
      break;
    }
  }
  if (!inserted) root.appendChild(el);
  return el;
}

function ensureGroup(root, key, label, fed) {
  let el = groupElByKey.get(key);
  if (el) return el;
  el = document.createElement('details');
  el.className = 'club-group';
  el.dataset.group = key;
  if (fed) el.dataset.federation = fed;
  if (key === LIVE_GROUP_KEY) {
    el.classList.add('club-group-live');
    el.open = true;
  }
  el.innerHTML = `
    <summary>
      <span class="club-arrow" aria-hidden="true"></span>
      <span class="club-title"></span>
      <span class="club-count"></span>
    </summary>
    <div class="club-grid"></div>
    <p class="club-empty">Ningú en directe ara mateix.</p>
  `;
  el.querySelector('.club-title').textContent = label;
  groupElByKey.set(key, el);

  if (key === LIVE_GROUP_KEY) {
    root.insertBefore(el, root.firstChild);
    return el;
  }

  // Club groups viuen dins el contenidor del seu macro grup (federació).
  const fg = ensureFederationGroup(root, fed || OTHERS_FED_KEY);
  const parent = fg.querySelector('.federation-children');
  let inserted = false;
  const existing = Array.from(parent.querySelectorAll(':scope > details.club-group'));
  for (const g of existing) {
    if (compareGroupKeys(g.dataset.group, key) > 0) {
      parent.insertBefore(el, g);
      inserted = true;
      break;
    }
  }
  if (!inserted) parent.appendChild(el);
  return el;
}

function groupGrid(group) {
  return group.querySelector('.club-grid');
}

function placeCardInLiveGroup(root, card) {
  const g = ensureGroup(root, LIVE_GROUP_KEY, LIVE_GROUP_LABEL);
  const grid = groupGrid(g);
  if (card.parentElement !== grid) grid.appendChild(card);
}

function placeCardInClubGroup(root, channel, card) {
  const club = clubNameFor(channel);
  const fed = federationKey(channel);
  const g = ensureGroup(root, club, club, fed);
  const grid = groupGrid(g);
  if (card.parentElement !== grid) grid.appendChild(card);
}

function updateAllGroupCounts() {
  for (const group of groupElByKey.values()) {
    const grid = groupGrid(group);
    const total = grid.children.length;
    const countEl = group.querySelector(':scope > summary > .club-count');
    countEl.textContent = total > 0 ? `(${total})` : '';
    group.classList.toggle('group-empty', total === 0);
  }
  for (const fg of federationGroupByKey.values()) {
    const children = fg.querySelector('.federation-children');
    const totalCards = children.querySelectorAll('.ch-card').length;
    const countEl = fg.querySelector(':scope > summary > .club-count');
    countEl.textContent = totalCards > 0 ? `(${totalCards})` : '';
    fg.classList.toggle('group-empty', totalCards === 0);
  }
  updateAppBadge();
}

// Badge "boleta WhatsApp" a la icona de la PWA instal·lada amb el nombre
// de directes actuals. Suportat a Chrome/Edge desktop+Android i a iOS
// 16.4+ amb notificacions concedides; els navegadors sense suport ignoren
// la crida silenciosament.
function updateAppBadge() {
  if (!('setAppBadge' in navigator)) return;
  const live = groupElByKey.get(LIVE_GROUP_KEY);
  const count = live ? live.querySelectorAll('.ch-card[data-status="live"]').length : 0;
  if (count > 0) {
    navigator.setAppBadge(count).catch(() => {});
  } else {
    navigator.clearAppBadge?.().catch(() => {});
  }
}

function renderChannelCards(channels) {
  const root = document.getElementById('channelCards');
  if (!root) return;
  const cache = loadCache();
  root.innerHTML = '';
  cardsByChannel.clear();
  groupElByKey.clear();
  federationGroupByKey.clear();

  // Live group sempre present, primer i visible (encara que estigui buit).
  ensureGroup(root, LIVE_GROUP_KEY, LIVE_GROUP_LABEL);

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
        placeCardInLiveGroup(root, card);
        set.add(s.videoId);
      }
      cardsByChannel.set(cKey, set);
    } else {
      const card = createCard({ cardKey: cKey, channel: ch, status: 'checking' });
      placeCardInClubGroup(root, ch, card);
      cardsByChannel.set(cKey, new Set([cKey]));
    }
  }

  updateAllGroupCounts();
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
        placeCardInClubGroup(root, ch, card);
      }
    } else {
      removeCardsByKeys(existing, root);
      const card = createCard({
        cardKey: result.key,
        channel: ch,
        status: result.error ? 'error' : 'offline',
      });
      placeCardInClubGroup(root, ch, card);
      cardsByChannel.set(result.key, new Set([result.key]));
    }
    updateAllGroupCounts();
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
      placeCardInLiveGroup(root, card);
    } else {
      const newCard = createCard({
        cardKey: stream.videoId,
        channel: ch,
        status: 'live',
        videoId: stream.videoId,
        title: stream.title,
      });
      placeCardInLiveGroup(root, newCard);
    }
  }

  cardsByChannel.set(result.key, desiredKeys);
  updateAllGroupCounts();
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
    return;
  }
  if (card.dataset.status === 'live') {
    selectStream(cardKey);
    return;
  }
  // Card no en directe: obre el canal de YouTube. Android App Links / iOS
  // Universal Links porten l'usuari directament a l'app si la té instal·lada.
  const ch = channelByKey.get(card.dataset.channelKey);
  const url = ch && youtubeChannelURL(ch);
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
}

function selectStream(videoId) {
  const card = document.querySelector(`.ch-card[data-key="${CSS.escape(videoId)}"]`);
  if (!card) return;
  const channelKeyVal = card.dataset.channelKey;
  const ch = channelByKey.get(channelKeyVal);
  if (!ch) return;
  if (playerByKey.size >= MAX_PLAYERS && !playerByKey.has(videoId)) {
    alert(
      `Has arribat al màxim de ${MAX_PLAYERS} reproductors simultanis. ` +
      `Atura'n algun per afegir-ne d'altres.`
    );
    return;
  }
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
  for (const group of groupElByKey.values()) {
    const grid = groupGrid(group);
    const cards = Array.from(grid.querySelectorAll(':scope > .ch-card'));
    cards.sort((a, b) => {
      const na = a.querySelector('.ch-name').textContent;
      const nb = b.querySelector('.ch-name').textContent;
      return na.localeCompare(nb, undefined, { numeric: true, sensitivity: 'base' });
    });
    cards.forEach(c => grid.appendChild(c));
  }
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
  // Amaga grups de club que no tenen cap card visible (excepte el live
  // group, que sempre s'ha de mostrar amb l'estat buit).
  for (const group of groupElByKey.values()) {
    if (group.dataset.group === LIVE_GROUP_KEY) {
      group.classList.remove('group-search-hidden');
      continue;
    }
    const grid = groupGrid(group);
    const total = grid.children.length;
    if (total === 0) continue;
    const hidden = grid.querySelectorAll(':scope > .ch-card.search-hidden').length;
    group.classList.toggle('group-search-hidden', hidden === total);
  }
  // Amaga macro grups quan tots els clubs queden ocults per la cerca.
  for (const fg of federationGroupByKey.values()) {
    const children = fg.querySelector('.federation-children');
    const visible = children.querySelectorAll(
      ':scope > details.club-group:not(.group-search-hidden):not(.group-empty)'
    ).length;
    fg.classList.toggle('group-search-hidden', visible === 0);
  }
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
  // Última barrera contra la saturació: maybeRestoreSelected/playFromNotification
  // poden saltar-se la comprovació de selectStream.
  if (playerByKey.size >= MAX_PLAYERS) return;
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
  if (!el) return;
  const n = playerByKey.size;
  el.textContent = n > 0 ? `(${n}/${MAX_PLAYERS})` : '';
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

async function tryFetchAllLive() {
  if (!WORKER_URL) return false;
  try {
    const res = await fetch(`${WORKER_URL}/all-live`, { cache: 'no-store' });
    if (!res.ok) return false;
    const data = await res.json();
    const age = Date.now() - (data.ts || 0);
    if (age > 10 * 60 * 1000) return false;
    const byKey = new Map();
    for (const c of data.channels || []) byKey.set(c.channelKey, c);
    for (const ch of channelByKey.values()) {
      const ck = channelKey(ch);
      const remote = byKey.get(ck);
      const result = { key: ck, name: ch.name, streams: remote?.streams || [] };
      updateChannelCards(result);
      maybeRestoreSelected(result);
    }
    sortCards();
    return true;
  } catch (err) {
    console.warn('/all-live failed', err);
    return false;
  }
}

async function checkAllChannels() {
  // Prefer the worker's pre-aggregated snapshot (single request, ~50ms)
  // and only fall back to per-channel scraping when the backend is unset
  // or stale (>10 min old).
  if (await tryFetchAllLive()) return;

  const channels = Array.from(channelByKey.values());
  await pLimit(FETCH_CONCURRENCY, channels, async ch => {
    try {
      const result = await checkOneChannel(ch);
      updateChannelCards(result);
      maybeRestoreSelected(result);
    } catch (err) {
      console.warn('channel check failed', ch.name, err);
      markChannelError(ch);
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

// ---------- Push notifications ----------

function urlB64ToUint8Array(b64) {
  const padding = '='.repeat((4 - b64.length % 4) % 4);
  const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function ensurePushSubscription() {
  if (!WORKER_URL) throw new Error('Backend de notificacions no configurat (WORKER_URL).');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('El teu navegador no suporta notificacions push.');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Permís de notificacions denegat.');

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub) return sub;

  if (!vapidPublic) {
    try {
      const r = await fetch(`${WORKER_URL}/vapid-public`);
      const data = await r.json();
      vapidPublic = data.key;
    } catch (_) { /* ignore */ }
  }
  if (!vapidPublic) throw new Error('No es pot obtenir la clau VAPID del backend.');

  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlB64ToUint8Array(vapidPublic),
  });
}

async function syncSubscriptionToBackend() {
  if (!WORKER_URL) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const channels = Array.from(subscribedChannels);
  if (channels.length === 0) {
    await fetch(`${WORKER_URL}/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    return;
  }
  await fetch(`${WORKER_URL}/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: sub.toJSON(), channels }),
  });
}

async function toggleBellForChannel(channelKeyVal) {
  const willEnable = !subscribedChannels.has(channelKeyVal);
  if (willEnable) {
    try {
      await ensurePushSubscription();
    } catch (err) {
      alert(err.message || String(err));
      return;
    }
    subscribedChannels.add(channelKeyVal);
  } else {
    subscribedChannels.delete(channelKeyVal);
  }
  savePushChannels();
  applyBellStates();
  try { await syncSubscriptionToBackend(); }
  catch (err) {
    console.warn('sync subscription failed', err);
  }
}

function applyBellStates() {
  document.querySelectorAll('.ch-card').forEach(card => {
    const ck = card.dataset.channelKey;
    if (!ck) return;
    card.dataset.notify = subscribedChannels.has(ck) ? 'on' : 'off';
  });
}

// ---------- Deep link from notification click ----------

function handleDeepLink() {
  const params = new URLSearchParams(location.search);
  const playId = params.get('play');
  if (!playId) return;
  // Add to selectedSet so maybeRestoreSelected picks it up after detection
  selectedSet.add(playId);
  saveSelected();
  // Clean the URL so refresh doesn't re-trigger
  history.replaceState({}, '', location.pathname);
}

async function playFromNotification(data) {
  if (!data?.videoId) return;
  // Channels may not be loaded yet if the SW message arrives during boot.
  for (let i = 0; i < 50 && channelByKey.size === 0; i++) {
    await new Promise(r => setTimeout(r, 100));
  }
  const ch = data.channelKey ? channelByKey.get(data.channelKey) : null;
  selectedSet.add(data.videoId);
  saveSelected();
  if (ch) {
    addPlayer(data.videoId, ch.name, data.videoId);
    switchTab('players');
  }
  // If we didn't find the channel, the next checkAllChannels pass will
  // restore via maybeRestoreSelected.
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'playFromNotification') {
      playFromNotification(e.data).catch(err => console.warn('playFromNotification', err));
    }
  });
}

// ---------- Init ----------

document.addEventListener('DOMContentLoaded', async () => {
  if (WORKER_URL) document.body.classList.add('push-enabled');
  const channels = await getChannels();
  handleDeepLink();
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
