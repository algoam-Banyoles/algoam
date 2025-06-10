// Introduceix aquí la teva clau de l'API de YouTube Data
const API_KEY = '';

async function getChannels() {
  const response = await fetch('canals.json');
  return response.json();
}

async function checkLiveStreams() {
  const results = document.getElementById('liveResults');
  results.textContent = 'Comprovant...';
  if (!API_KEY) {
    results.textContent = 'Cal definir API_KEY a canal.js';
    return;
  }
  const channels = await getChannels();
  results.innerHTML = '';
  for (const channel of channels) {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channel.channelId}&eventType=live&type=video&key=${API_KEY}`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data.items && data.items.length > 0) {
        const videoId = data.items[0].id.videoId;
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = `https://www.youtube.com/watch?v=${videoId}`;
        a.textContent = channel.name;
        a.target = '_blank';
        li.appendChild(a);
        results.appendChild(li);
      }
    } catch (err) {
      console.error('Error checking channel', channel.channelId, err);
    }
  }
  if (!results.hasChildNodes()) {
    results.textContent = 'No hi ha transmissions en directe ara mateix.';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('checkLive');
  if (btn) {
    btn.addEventListener('click', checkLiveStreams);
  }
});
