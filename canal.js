// Clau de l'API de YouTube Data a utilitzar per defecte. Pots canviar-la o
// deixar-la buida si prefereixes emprar el mètode alternatiu que comprova la
// pàgina /live del canal.
const API_KEY = 'AIzaSyBbSKKTu-PNoWZ_MPwNnTi5iaFZmsk3dQw';

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

async function checkLiveStreams() {
  const results = document.getElementById('liveResults');
  results.textContent = 'Comprovant...';
  const channels = await getChannels();
  let cleared = false;
  for (const channel of channels) {
    if (API_KEY) {
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channel.channelId}&eventType=live&type=video&key=${API_KEY}`;
      try {
        const res = await fetch(url);
        const data = await res.json();

        if (!res.ok || data.error) {
          console.error('API error', data.error || res.statusText);
          continue;
        }

        if (data.items && data.items.length > 0) {
          if (!cleared) {
            results.innerHTML = '';
            cleared = true;
          }
          const videoId = data.items[0].id.videoId;
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.href = `https://www.youtube.com/watch?v=${videoId}`;
          a.textContent = channel.name;
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
    } else {
      try {
        const livePath = channel.handle
          ? `https://www.youtube.com/${channel.handle}/live`
          : `https://www.youtube.com/channel/${channel.channelId}/live`;
        const proxyUrl = `https://corsproxy.io/?${livePath}`;
        const res = await fetch(proxyUrl, { redirect: 'follow' });
        if (!res.ok) {
          console.error('Fallback fetch error', res.statusText);
          continue;
        }
        const finalUrl = decodeURIComponent(
          res.url.replace('https://corsproxy.io/?', '')
        );
        let match = finalUrl.match(/(?:[?&]v=|\/live\/)([^&/?]+)/);
        if (!match) {
          const html = await res.text();
          match = html.match(/"(?:watch\?v=|videoId\":\")([\w-]{11})/);
        }
        if (match) {
          if (!cleared) {
            results.innerHTML = '';
            cleared = true;
          }
          const videoId = match[1];
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.href = `https://www.youtube.com/watch?v=${videoId}`;
          a.textContent = channel.name;
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
        console.error(
          'Error checking channel without API',
          channel.channelId,
          err
        );
      }
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
