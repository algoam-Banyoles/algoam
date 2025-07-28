async function loadPlayers() {
  const res = await fetch('players.json');
  const players = await res.json();
  players.forEach(p => {
    p.mean = p.history.reduce((sum, val) => sum + val, 0) / p.history.length;
  });
  players.sort((a, b) => b.mean - a.mean);
  return players;
}

function createPlayerList(players) {
  const container = document.getElementById('playerList');
  container.innerHTML = '';
  players.forEach(player => {
    const li = document.createElement('li');
    li.className = 'collection-item';
    const a = document.createElement('a');
    a.className = 'blue-text text-darken-2';
    a.href = '#!';
    a.textContent = `${player.name} - ${player.mean.toFixed(2)}`;
    a.addEventListener('click', e => {
      e.preventDefault();
      showPlayerEvolution(player);
    });
    li.appendChild(a);
    container.appendChild(li);
  });
}

function showPlayerEvolution(player) {
  const ctx = document.getElementById('playerChart').getContext('2d');
  if (window.currentChart) {
    window.currentChart.destroy();
  }
  window.currentChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: player.history.map((_, i) => `Partida ${i + 1}`),
      datasets: [{
        label: player.name,
        data: player.history,
        borderColor: 'blue',
        fill: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false
    }
  });
  const modal = document.getElementById('chartModal');
  const instance = M.Modal.getInstance(modal);
  instance.open();
}

function setupModal() {
  const modal = document.getElementById('chartModal');
  M.Modal.init(modal);
}

document.addEventListener('DOMContentLoaded', async () => {
  setupModal();
  try {
    const players = await loadPlayers();
    createPlayerList(players);
  } catch (err) {
    console.error('Failed to load players', err);
  }
});
