// Copia aquest fitxer a `config.js` (gitignored) per configurar opcions opcionals.
//
// CORS_PROXY      proxy per fer scrape de YouTube. Per defecte
//                 https://api.codetabs.com/v1/proxy?quest=. canal.js encadena
//                 la URL via encodeURIComponent.
// WORKER_URL      URL del Cloudflare Worker que envia push notifications
//                 (vegeu worker/README.md). Sense aquesta variable, els bells
//                 de notificacions de cada canal estan deshabilitats.
// VAPID_PUBLIC    Clau pública VAPID (base64url) que correspon al worker.
//                 Si no s'indica aquí, la PWA la demana via /vapid-public.
// MAX_PLAYERS     Sostre de reproductors simultanis. Per defecte es calcula
//                 segons cores/memòria del dispositiu (mòbil 2-4, escriptori
//                 4-16). Sobreescriu-lo per pujar/baixar manualment.
// SCORES_URL      URL del snapshot de marcadors (mateix format que
//                 scoreboard/out/scores_latest.json). Per defecte la PWA el
//                 llegeix d'aquesta ruta relativa, així que només funciona
//                 quan serveixes el directori amb el poller corrent. Quan
//                 cablegem el worker, apunta'l a /scores.
// LIVESYNC_DISABLED  Posa a true per desactivar el "snap al directe"
//                 automàtic. El botó flotant "DIRECTE" segueix funcionant
//                 per fer-ho manualment. Útil si algun reproductor es
//                 queda encallat per culpa dels seeks.
//
// window.APP_CONFIG = {
//   CORS_PROXY: 'https://el-teu-proxy/?',
//   WORKER_URL: 'https://algoam-push.xxxx.workers.dev',
//   VAPID_PUBLIC: 'BLn7N6...',
//   MAX_PLAYERS: 9,
//   SCORES_URL: 'https://algoam-push.xxxx.workers.dev/scores',
// };
