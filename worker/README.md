# Multiview push backend

Cloudflare Worker que:
1. Rep subscripcions Web Push de la PWA i les emmagatzema (per endpoint i per canal).
2. Rep cada 5 min la llista actualitzada de directes (l'envia GitHub Actions al script `scripts/poll_and_post.js`), la diferencia amb l'estat anterior, i envia push notifications per als nous directes.
3. Serveix l'endpoint públic `GET /all-live` perquè la PWA pugui hidratar l'estat amb una sola petició petita en lloc de scrapejar 80 canals des del navegador.

L'scrape pesat (80 canals × ~1MB) **no** s'executa al worker (el free tier de Cloudflare limita a 50 subrequests per invocació). Es fa a GitHub Actions runners on no hi ha aquest límit.

## Requisits

- Compte gratuït a Cloudflare (https://dash.cloudflare.com)
- Node.js 18+ amb `npm`
- Repositori GitHub d'aquest projecte (per al cron amb GH Actions)

## Setup en 6 passos

```bash
cd algoam/worker
npm install
```

### 1. Generar les claus VAPID

```bash
npx web-push generate-vapid-keys
```

Apunta les dues claus (`Public Key` i `Private Key`).

### 2. Crear el namespace KV

```bash
npx wrangler login
npx wrangler kv namespace create ALGOAM_KV
```

Copia l'`id` que imprimeix i posa'l a `wrangler.toml` substituint `REPLACE_WITH_KV_NAMESPACE_ID`.

### 3. Configurar el `wrangler.toml`

Edita `[vars] ALLOWED_ORIGIN` perquè coincideixi amb l'URL on tens publicada la PWA (per defecte `https://algoam-banyoles.github.io`). Si la serveixes en local, també pots posar-hi `*` temporalment.

### 4. Definir secrets al worker

```bash
npx wrangler secret put VAPID_PUBLIC
npx wrangler secret put VAPID_PRIVATE
npx wrangler secret put POLL_SECRET     # qualsevol cadena llarga aleatòria
```

### 5. Desplegar el worker

```bash
npx wrangler deploy
```

L'output dirà `https://algoam-push.<el-teu-subdomain>.workers.dev`. Apunta aquesta URL.

### 6. Configurar la PWA i el cron

A `algoam/config.js` (no es commiteja, vegeu `config.sample.js`):

```js
window.APP_CONFIG = {
  WORKER_URL: 'https://algoam-push.xxxx.workers.dev',
  VAPID_PUBLIC: 'BLn7N6...la teva clau pública',
};
```

A `Settings → Secrets and variables → Actions` del repositori GitHub, afegeix:
- `WORKER_URL` = la mateixa URL del worker
- `POLL_SECRET` = el mateix valor que has posat al worker

A partir d'ara el workflow `.github/workflows/notify-poll.yml` cridarà l'endpoint `/poll` cada 5 minuts.

## Verificar

```bash
# Comprovar que el worker respon
curl https://algoam-push.xxxx.workers.dev/vapid-public
# {"key":"BLn7N6..."}

# Forçar una poll manual des del repo (scrape + post)
WORKER_URL=https://algoam-push.xxxx.workers.dev \
POLL_SECRET=<el-teu-secret> \
node algoam/scripts/poll_and_post.js
# Imprimeix els canals en directe i la resposta del worker

# Veure l'estat agregat actual
curl https://algoam-push.xxxx.workers.dev/all-live
# {"ts":1714750000000,"channels":[{"channelKey":"UC...","name":"...","streams":[...]}]}
```

A la PWA, clica la campaneta d'una targeta i confirma la sol·licitud de permís de notificacions. Quan el canal entri en directe, rebràs una notificació en menys de 5 minuts.

## Cost

Tot dins del free tier:
- Cloudflare Workers: 100k req/dia (n'usem ~300/dia)
- Cloudflare KV: 100k lectures/dia + 1k escriptures/dia
- GitHub Actions: 2.000 min/mes a repositoris públics (un tick són uns 10s → ~3 min/dia)
- Total: 0 €/mes

## Manteniment

- Les claus VAPID no caduquen però convé rotar-les si s'exposen.
- Si un usuari es desinstal·la la PWA, el worker rebrà 410 Gone i eliminarà la subscripció automàticament.
- Per fer un debug, mira els logs en directe: `npx wrangler tail`.
