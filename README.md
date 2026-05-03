# Multiview — directes

PWA per veure simultàniament tots els canals de YouTube de `canals.json` que estan emetent en directe. Es pot instal·lar gràcies al manifest i al service worker.

## Ús

1. Servir aquest directori amb un servidor web local, p.ex. `npx http-server -p 8080 -c-1` o `python -m http.server 8080`.
2. Obrir `http://localhost:8080` al navegador (no funciona via `file://`).
3. En carregar la pàgina:
   - Es comproven automàticament tots els canals en paral·lel.
   - Cada canal en directe es **reprodueix automàticament** (autoplay mutejat — el navegador només permet autoplay sense so).
   - Una graella inferior mostra l'estat de tots els canals (en directe / offline / comprovant).
4. Per **aturar un reproductor**, cliqueu el botó **×** que té a sobre. Mentre la pestanya estigui oberta no es tornarà a engegar sol.
5. La detecció es repeteix cada 90 segons; els nous directes apareixen automàticament, els ja aturats no.
6. Filtre **Només directes** a la barra superior de la graella per amagar els canals offline.

## Detecció sense API de Google

L'aplicació **no requereix cap clau d'API**. Per a cada canal:

1. Es fa fetch de `youtube.com/@handle/live` (o `/channel/ID/live`) a través d'un proxy CORS.
2. Sobre l'HTML rebut s'extreu el `videoId` (`/"videoId":"([\w-]{11})"/`) i es confirma que és emissió en directe real (`/"isLiveContent":true/` o `/"isLiveNow":true/`).
3. La miniatura es construeix com `https://i.ytimg.com/vi/VIDEOID/hqdefault.jpg` (CDN públic).

Resultats memoritzats 5 minuts a `localStorage` (clau `liveCache`). Configurable a `canal.js` (`CACHE_TTL`).

## Configuració opcional

Si el proxy CORS per defecte (`https://corsproxy.io/?`) us dóna problemes (403/429), creeu un fitxer `config.js` amb:

```js
window.APP_CONFIG = { CORS_PROXY: 'https://el-vostre-proxy/?' };
```

Veure `config.sample.js`.

## Línia de comandes

Cal **Node.js 18** o superior.

```bash
node scripts/check_live.js
```

Imprimeix una línia d'estat per cada canal:

```
OK MyChannel en emissió: https://www.youtube.com/watch?v=abc123defgh — Títol del directe
KO OtherChannel sense emissió
```

També sense API.

## Actualitzar la llista de canals

```bash
npm install
npm run fetch-channels
```

Genera/actualitza `canals.json` amb identificadors i handles.

## WebSub listener (opcional, no usat per la PWA)

`websub_server.js` se subscriu al feed WebSub d'un canal concret i registra quan comença un directe. Verificació també sense API:

```bash
CHANNEL_ID=UC... CALLBACK_URL=https://example.com/websub node websub_server.js
```

## Notificacions push (opcional)

Quan un canal entri en directe, la PWA pot enviar una notificació. Cal desplegar el petit backend de [algoam/worker/](worker/) (Cloudflare Workers + GitHub Actions cron). Vegeu [worker/README.md](worker/README.md) per als 6 passos de setup. Tot dins del free tier; cost 0 €/mes.

Un cop desplegat:
1. Afegir `WORKER_URL` i `VAPID_PUBLIC` al `config.js` (vegeu `config.sample.js`).
2. A la pestanya **Directes**, clica la campaneta de qualsevol targeta. La primera vegada el navegador demanarà permís de notificacions.
3. La campaneta passa a verda i el canal queda subscrit.
4. Quan el canal entri en directe (en menys de 5 min), rebràs una notificació amb el títol del directe; clicant-la, l'app s'obre i afegeix el reproductor automàticament.

## Resolució de problemes

- **403 / 429 al servidor proxy CORS**: configureu un `CORS_PROXY` propi (vegeu *Configuració opcional*).
- **Cap reproductor no apareix tot i tenir directes coneguts**: comproveu la consola del navegador. Si el proxy està bloquejat, totes les peticions fallen.
- **El reproductor mostra "vídeo no disponible"**: el directe pot haver acabat. Aturar el reproductor amb × (no es torna a engegar fins que recarregueu la pestanya).
