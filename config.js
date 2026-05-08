window.APP_CONFIG = {
  WORKER_URL: 'https://algoam-push.algoam.workers.dev',
  VAPID_PUBLIC: 'BFeApteAcqrZ2kfETOhltrrrh5YF-PZRVAllmFxKaviao_AOv2YASDrFcZMahIDRXB-32rHQ5IgDh2FxNRn2adQ',
  SCORES_URL: 'https://algoam-push.algoam.workers.dev/scores',
  // A/B test: el botó "DIRECTE" segueix funcionant per re-sync manual.
  // Si amb live-sync apagat la reproducció ja no s'encalla, retornem-lo
  // amb una lògica menys agressiva. Si encara s'encalla, el problema
  // és aliè (YouTube embed, multi-iframe, network) i podem reactivar.
  LIVESYNC_DISABLED: true,
};
