// Clau de l'API de YouTube Data a utilitzar per defecte. Pots canviar-la o
// deixar-la buida si prefereixes emprar el mètode alternatiu que comprova la
// pàgina /live del canal.
const API_KEY = 'AIzaSyAgQNSOrxd5EQYZTbLpY63mcafFOP519Jo';

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
  for (const channel of channels) {
    try {
      const paths = [];
      if (channel.handle) {
        paths.push(`https://www.youtube.com/${channel.handle}/live`);
      }
      if (channel.channelId) {
        paths.push(`https://www.youtube.com/channel/${channel.channelId}/live`);
      }
      let videoId = null;
      for (const livePath of paths) {
        const proxyUrl = `https://corsproxy.io/?${livePath}`;

        let res = await fetch(proxyUrl, { method: 'HEAD', redirect: 'manual' });
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
          const finalUrl = decodeURIComponent(res.url.replace('https://corsproxy.io/?', ''));
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
        let title = channel.name;
        let isLive = true;
        if (API_KEY) {
          const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${videoId}&key=${API_KEY}`;
          const apiRes = await fetch(apiUrl);
          const data = await apiRes.json();
          if (apiRes.ok && data.items && data.items.length > 0) {
            const item = data.items[0];
            title = item.snippet.title;
            isLive = item.snippet.liveBroadcastContent === 'live' ||
              (item.liveStreamingDetails &&
               item.liveStreamingDetails.actualStartTime &&
               !item.liveStreamingDetails.actualEndTime);
          } else if (data.error) {
            console.error('API error', data.error);
          }
        }
        if (!isLive) {
          continue;
        }
        if (!cleared) {
          results.innerHTML = '';
          cleared = true;
        }
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = `https://www.youtube.com/watch?v=${videoId}`;
        a.textContent = title;
        a.target = '_blank';
        const copyBtn = document.createElement('button');
        copyBtn.textContent = 'Copiar';
        copyBtn.addEventListener('click', () => {
          fillNextInput(`https://www.youtube.com/watch?v=${videoId}`);
        });
        li.appendChild(a);
        li.appendChild(copyBtn);
        results.appendChild(li);
      }
    } catch (err) {
      console.error('Error checking channel', channel.channelId, err);
    }
  }
  if (!cleared) {
    results.textContent = 'No hi ha transmissions en directe ara mateix.';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('checkLive');
  if (btn) {
    btn.addEventListener('click', checkLiveStreams);
  }
});
