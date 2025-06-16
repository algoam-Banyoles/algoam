// Clau de l'API de YouTube Data.
// Assigna-la a `window.APP_CONFIG.API_KEY` al fitxer `config.js`.
const API_KEY = window.APP_CONFIG?.API_KEY || '';
const CORS_PROXY = window.APP_CONFIG?.CORS_PROXY || 'https://corsproxy.io/?';

// Quant de temps (ms) es manté a la memòria cau el resultat d'un canal

const CACHE_TTL = 5 * 60 * 1000; // 5 minuts

const CACHE_KEY = 'liveCache';

// Si és `true` cada vídeo detectat es validarà amb l'API; en cas contrari només
// s'emprarà la redirecció/HTML per deduir que és en directe.
const VERIFY_WITH_API = true;

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

function fillNextInput(url) {
  for (let i = 1; i <= 4; i++) {
    const input = document.querySelector(`[name="url${i}"]`);
    if (input && !input.value.trim()) {
      input.value = url;
      break;
    }
  }
}

async function getLiveVideoIdFromApi(channelId) {
  if (!API_KEY || !channelId) return null;
  try {
    const url =
      `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&eventType=live&type=video&key=${API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (res.ok && data.items && data.items.length > 0) {
      const item = data.items.find(
        it => it.snippet.liveBroadcastContent === 'live' && it.id?.videoId
      );
      return item?.id.videoId || null;
    }
  } catch (err) {
    console.error('API search error', err);
  }
  return null;
}

async function checkLiveStreams() {
  const results = document.getElementById('liveResults');
  results.textContent = 'Comprovant...';
  const channels = await getChannels();
  let cleared = false;
  const cache = loadCache();
  const now = Date.now();
  let fetchError = false;
  for (const channel of channels) {
    try {
      const key = channel.channelId || channel.handle;
      const cached = cache[key];
      if (cached && now - cached.ts < CACHE_TTL) {
        if (cached.videoId) {
          if (!cleared) {
            results.innerHTML = '';
            cleared = true;
          }
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.href = `https://www.youtube.com/watch?v=${cached.videoId}`;
          a.textContent = channel.name;
          if (cached.title) a.title = cached.title;
          a.target = '_blank';
          const copyBtn = document.createElement('button');
          copyBtn.textContent = 'Copiar';
          copyBtn.addEventListener('click', () => {
            fillNextInput(`https://www.youtube.com/watch?v=${cached.videoId}`);
          });
          li.appendChild(a);
          li.appendChild(copyBtn);
          results.appendChild(li);
        }
        continue;
      }
      const paths = [];
      if (channel.handle) {
        paths.push(`https://www.youtube.com/${channel.handle}/live`);
      }
      if (channel.channelId) {
        paths.push(`https://www.youtube.com/channel/${channel.channelId}/live`);
      }
      let videoId = null;
      for (const livePath of paths) {
        const proxyUrl = `${CORS_PROXY}${livePath}`;

        let res = await fetch(proxyUrl, { method: 'HEAD', redirect: 'manual' });
        if (res.status === 403) fetchError = true;
        const headLocation = res.headers.get('Location') || res.headers.get('location');
        console.log(`[HEAD] ${livePath} -> ${res.status}${headLocation ? ` ${headLocation}` : ''}`);
        if (res.status >= 300 && res.status < 400) {
          const location = headLocation;
          const match = location && location.match(/v=([\w-]{11})/);
          if (match) {
            videoId = match[1];
          }
        }

        if (!videoId) {
          res = await fetch(proxyUrl, { redirect: 'follow' });
          if (res.status === 403) fetchError = true;
          const finalUrl = decodeURIComponent(res.url.replace(CORS_PROXY, ''));
          let match = finalUrl.match(/[?&]v=([\w-]{11})/);
          if (!match) {
            const html = await res.text();
            match = html.match(/"(?:watch\?v=|videoId\":\")([\w-]{11})/);
          }
          if (match) videoId = match[1];
        }

        if (videoId) break;
      }

      if (!videoId && channel.channelId) {
        videoId = await getLiveVideoIdFromApi(channel.channelId);
      }

      if (videoId) {
        let videoTitle = '';
        let isLive = true;
        if (VERIFY_WITH_API && API_KEY) {
          const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${videoId}&key=${API_KEY}`;
          const apiRes = await fetch(apiUrl);
          const data = await apiRes.json();
          if (apiRes.ok && data.items && data.items.length > 0) {
            const item = data.items[0];
            videoTitle = item.snippet.title;
            isLive = item.snippet.liveBroadcastContent === 'live' ||
              (item.liveStreamingDetails &&
               item.liveStreamingDetails.actualStartTime &&
               !item.liveStreamingDetails.actualEndTime);
          } else if (data.error) {
            console.error('API error', data.error);
          }
        }
        if (!isLive) {
          cache[key] = { ts: now, videoId: null };
          continue;
        }
        cache[key] = { ts: now, videoId, title: videoTitle };
        if (!cleared) {
          results.innerHTML = '';
          cleared = true;
        }
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = `https://www.youtube.com/watch?v=${videoId}`;
        a.textContent = channel.name;
        if (videoTitle) a.title = videoTitle;
        a.target = '_blank';
        const copyBtn = document.createElement('button');
        copyBtn.textContent = 'Copiar';
        copyBtn.addEventListener('click', () => {
          fillNextInput(`https://www.youtube.com/watch?v=${videoId}`);
        });
        li.appendChild(a);
        li.appendChild(copyBtn);
        results.appendChild(li);
      } else {
        cache[key] = { ts: now, videoId: null };
      }
    } catch (err) {
      console.error('Error checking channel', channel.channelId, err);
    }
  }
  if (!cleared) {
    if (fetchError) {
      results.textContent = 'Error 403 en fer les consultes. Revisa la configuració de CORS_PROXY a config.js.';
    } else {
      results.textContent = 'No hi ha transmissions en directe ara mateix.';
    }
  }
  saveCache(cache);
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('checkLive');
  if (btn) {
    btn.addEventListener('click', checkLiveStreams);
  }
});
