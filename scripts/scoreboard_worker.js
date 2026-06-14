// Worker de marcadors en VIU dels opens.
//
// Per cada open en curs (taula fcbillar.open_live a Supabase):
//   1) Deriva les seus (venues) i troba els directes dels clubs (find_open_streams).
//   2) Per cada directe el títol dóna open+fase+grup+jugadors.
//   3) Mostreja N fotogrames i pren el CONSENS de caramboles (read_scoreboard);
//      així es descarten glitches i moments de rellotge vermell (escalfament/
//      mitja part) que no llegeixen.
//   4) Publica/actualitza a fcbillar.open_live_scores (upsert per video_id) i
//      retira les files de directes que ja no estan en emissió.
//
// Cal SUPABASE_URL i SUPABASE_SERVICE_ROLE_KEY a l'entorn.
//   node scripts/scoreboard_worker.js [--once] [--samples N]

const { spawnSync, execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { readScoreboard, closeWorker } = require('./read_scoreboard');
const { liveStreamsForTokens, norm } = require('./find_open_streams');
const paddle = require('./paddle_client');

// Lector OCR: PaddleOCR (sidecar persistent — molt millor amb la font carombooks,
// llegeix el "7" corbat i multi-dígit que tesseract confon) si arrenca; si no,
// tesseract.js com a alternativa. El sidecar es manté viu entre passades (mode --loop).
let _readFrame = readScoreboard;
let _readerInited = false;
async function ensureReader(log) {
  if (_readerInited) return;
  _readerInited = true;
  try {
    paddle.start({ onLog: log });
    await paddle.waitReady(150000);
    _readFrame = (f) => paddle.read(f);
    log('OCR: PaddleOCR (sidecar) actiu');
  } catch (e) {
    _readFrame = readScoreboard;
    log(`OCR: tesseract.js (PaddleOCR no disponible: ${e.message})`);
  }
}
function closeReaders() { try { paddle.close(); } catch { /* noop */ } closeWorker().catch(() => {}); }

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SCHEMA = 'fcbillar';

async function supa(method, table, { query = '', body = null, upsert = false } = {}) {
  if (!SUPA_URL || !SUPA_KEY) throw new Error('Falten SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  const headers = {
    apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
    'Content-Type': 'application/json', 'Accept-Profile': SCHEMA, 'Content-Profile': SCHEMA,
  };
  if (upsert) headers.Prefer = 'resolution=merge-duplicates';
  const res = await fetch(`${SUPA_URL}/rest/v1/${table}${query}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${table} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

// Token distintiu del nom de l'open (sense paraules genèriques) per validar que
// el títol de l'stream és d'aquest open.
function openToken(name) {
  return norm(name).replace(/OPEN|TRES BANDES|3 BANDES|3B|QUADRE 47\/2|QUADRE 71\/2|Q47\/2|FEMENI/g, '').replace(/\s+/g, ' ').trim();
}

// Valida que el títol de l'stream és d'aquest open. NO exigim el token sencer
// (els clubs abreugen: "OPEN 3B C. DAURADA" en lloc de "COSTA DAURADA"), sinó que
// el títol contingui ALMENYS UNA paraula DISTINTIVA de l'open (≥5 lletres, p.ex.
// "DAURADA"). Si l'open no en té cap, no filtrem (deixem passar).
function titleMatchesOpen(title, ot) {
  if (!ot) return true;
  const words = ot.split(' ').filter((w) => w.length >= 5);
  if (!words.length) return norm(title).includes(ot);
  const T = norm(title);
  return words.some((w) => T.includes(w));
}

function venueTokens(payload) {
  const v = new Set();
  for (const ph of payload?.phases || []) for (const g of ph.groups || []) if (g.venue) v.add(g.venue.trim());
  return [...v];
}

// Parseig heurístic del títol → {players:[a,b], group, phase}.
function parseTitle(title) {
  const t = title.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim(); // treu (clubs)
  const group = (t.match(/GRUP\s+([A-Z0-9]+)/i) || [])[1] || null;
  const phase = (t.match(/PRE[\s-]*PRE?V[IÍ]?[AES]*|PR[EÈ]VI[AES]+|SETZENS|VUITENS|QUARTS|SEMIFINALS?|FINAL/i) || [])[0] || null;
  let players = [];
  const idx = t.search(/\sVS\s|\s[-–]\s/i);
  if (idx >= 0) {
    let left = t.slice(0, idx).trim();
    let right = t.slice(idx).replace(/^\s*(VS|[-–])\s*/i, '').trim();
    // Treu el prefix (open/fase/grup) de l'esquerra: quedar-nos amb el nom.
    const cut = left.search(/GRUP\s+[A-Z0-9]+\s+|PRE[\s-]*PREV\w*\s+|PR[EÈ]VI[AES]+\s+|PREV\s+/i);
    if (cut >= 0) left = left.replace(/.*(GRUP\s+[A-Z0-9]+|PRE[\s-]*PREV\w*|PR[EÈ]VI[AES]+|PREV)\s+/i, '');
    right = right.split(/\s{2,}/)[0].trim();
    players = [left, right].map((s) => s.trim()).filter(Boolean);
  }
  return { players, group, phase: phase ? phase.toUpperCase() : null };
}

// Jugadors reals de l'open (de open_live): [{name, group}].
function openPlayers(payload) {
  const out = [];
  for (const ph of payload?.phases || []) for (const g of ph.groups || []) for (const s of g.standings || []) {
    if (s.player_name) out.push({ name: s.player_name, group: g.label });
  }
  return out;
}

// Grup REAL de la partida: l'etiqueta on apareixen ELS DOS jugadors. El títol del
// vídeo pot ser erroni i un jugador pot constar en grups de fases diferents (i els
// noms de grup es poden solapar entre fases), així que el grup fiable és el que
// COMPARTEIXEN tots dos. Prioritza l'última aparició (fase més avançada).
// Igualtat ESTRICTA de jugadors canònics (noms complets de l'open). NO usem el
// solapament fluix de sameName per a noms canònics: els cognoms es repeteixen
// (FERNÁNDEZ VELASCO ≠ FERNÁNDEZ BARRAGAN, en grups diferents) i confondre'ls
// trencaria la regla "els dos jugadors d'una partida són del mateix grup".
const _canon = (s) => norm(s || '').replace(/[^A-Z0-9]/g, '');
function canonEq(a, b) { return !!a && !!b && _canon(a) === _canon(b); }

function matchGroup(aName, bName, players) {
  if (!aName || !bName) return null;
  const aG = players.filter((p) => canonEq(p.name, aName)).map((p) => p.group);
  const bG = new Set(players.filter((p) => canonEq(p.name, bName)).map((p) => p.group));
  const shared = aG.filter((g) => bG.has(g));
  return shared.length ? shared[shared.length - 1] : null;
}

// Resol un nom (OCR o títol, sovint només cognom) al jugador canònic de l'open
// per solapament de tokens. Retorna {name, group} o null.
function resolvePlayer(name, players) {
  if (!name) return null;
  const n = norm(name).replace(/[^A-Z ]/g, '').trim();
  const ntoks = n.split(/\s+/).filter((t) => t.length >= 3);
  if (!ntoks.length) return null;
  let best = null, bestScore = 0;
  for (const p of players) {
    const ptoks = norm(p.name).replace(/[^A-Z ]/g, '').split(/\s+/).filter((t) => t.length >= 3);
    let s = 0;
    for (const nt of ntoks) for (const pt of ptoks) {
      if (pt === nt) s += 2; else if (pt.includes(nt) || nt.includes(pt)) s += 1;
    }
    if (s > bestScore) { bestScore = s; best = p; }
  }
  return bestScore >= 1 ? best : null;
}

// Mateix jugador (per solapament de tokens del cognom).
function sameName(a, b) {
  if (!a || !b) return false;
  const ta = norm(a).replace(/[^A-Z ]/g, '').split(/\s+/).filter((t) => t.length >= 3);
  const tb = norm(b).replace(/[^A-Z ]/g, '').split(/\s+/).filter((t) => t.length >= 3);
  return ta.some((x) => tb.includes(x));
}

// Totes les partides dels grups (de open_live): [{a, b, group, played, ca, cb}].
// ca/cb (caramboles) permeten saber el guanyador/perdedor d'una partida jugada,
// necessari per l'ordre de joc (g2 = seed1 vs PERDEDOR de g1).
function openMatches(payload) {
  const out = [];
  for (const ph of payload?.phases || []) for (const g of ph.groups || []) for (const m of g.matches || []) {
    if (m.player_a && m.player_b) out.push({
      a: m.player_a, b: m.player_b, group: g.label, played: !!m.is_played,
      ca: m.caramboles_a, cb: m.caramboles_b,
    });
  }
  return out;
}

// Quan un costat no resol, dedueix el rival pel grup. Si el jugador conegut té UNA
// sola partida pendent, el rival és l'altre. Si en té DUES (típic del cap de sèrie
// a mig grup de 3), aplica l'ORDRE DE JOC: g1 = 2n vs 3r, g2 = 1r vs PERDEDOR(g1),
// g3 = 1r vs GUANYADOR(g1). Per tant la que toca ara és contra el PERDEDOR de la
// partida ja jugada entre els altres dos.
function opponentInGroup(name, matches, players) {
  const inv = matches.filter((m) => canonEq(m.a, name) || canonEq(m.b, name));
  const pending = inv.filter((m) => !m.played);
  let pool = pending.length === 1 ? pending : (inv.length === 1 ? inv : []);
  if (pool.length !== 1 && pending.length === 2) {
    // Els dos rivals pendents de `name`; la partida entre ells (g1) decideix l'ordre.
    const others = [...new Set(pending.flatMap((m) => [m.a, m.b]).filter((p) => !canonEq(p, name)))];
    if (others.length === 2) {
      const g1 = matches.find((m) =>
        (canonEq(m.a, others[0]) && canonEq(m.b, others[1])) ||
        (canonEq(m.a, others[1]) && canonEq(m.b, others[0])));
      if (g1 && g1.played && Number.isInteger(g1.ca) && Number.isInteger(g1.cb) && g1.ca !== g1.cb) {
        const loser = g1.ca < g1.cb ? g1.a : g1.b;  // menys caramboles = perdedor → rival de g2
        pool = pending.filter((m) => canonEq(m.a, loser) || canonEq(m.b, loser));
      }
    }
  }
  if (pool.length !== 1) return null;
  const oppName = canonEq(pool[0].a, name) ? pool[0].b : pool[0].a;
  return players.find((p) => canonEq(p.name, oppName)) || { name: oppName, group: pool[0].group };
}

// Candidats d'un nom OCR/títol (sovint parcial) als jugadors, per solapament de
// tokens. Retorna [{p, s}] ordenat per score desc (s>=1). Per a noms canònics
// fes servir canonEq; això és NOMÉS per fer encaixar text d'OCR/títol amb jugadors.
function candidates(name, players) {
  if (!name) return [];
  const ntoks = norm(name).replace(/[^A-Z ]/g, '').split(/\s+/).filter((t) => t.length >= 3);
  if (!ntoks.length) return [];
  const out = [];
  for (const p of players) {
    const ptoks = norm(p.name).replace(/[^A-Z ]/g, '').split(/\s+/).filter((t) => t.length >= 3);
    let s = 0;
    for (const nt of ntoks) for (const pt of ptoks) {
      if (pt === nt) s += 2; else if (pt.includes(nt) || nt.includes(pt)) s += 1;
    }
    if (s > 0) out.push({ p, s });
  }
  return out.sort((a, b) => b.s - a.s);
}
function scoreName(name, player) { const c = candidates(name, [player]); return c.length ? c[0].s : 0; }

// Resol la PARELLA d'una partida a partir de pistes (noms OCR + títol), amb les
// regles dures de l'usuari: (1) els dos jugadors han de ser del MATEIX grup;
// (2) preferim la partida PENDENT (la que s'està jugant) a una de ja jugada. Si
// només un costat és fiable, dedueix el rival pel grup. Retorna [pA, pB] (algun
// pot ser null) o null si no s'identifica ningú.
function resolvePairing(hints, oplayers, omatches) {
  const cand = new Map();  // name -> {p, s} (millor score per jugador entre totes les pistes)
  for (const h of hints) for (const { p, s } of candidates(h, oplayers)) {
    if (!cand.has(p.name) || cand.get(p.name).s < s) cand.set(p.name, { p, s });
  }
  const cs = [...cand.values()].sort((a, b) => b.s - a.s);
  let best = null;
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
    const a = cs[i], b = cs[j];
    if (canonEq(a.p.name, b.p.name) || !matchGroup(a.p.name, b.p.name, oplayers)) continue;  // mateix grup obligatori
    const m = omatches.find((mm) => (canonEq(mm.a, a.p.name) && canonEq(mm.b, b.p.name)) || (canonEq(mm.a, b.p.name) && canonEq(mm.b, a.p.name)));
    const pend = m ? (m.played ? 8 : 80) : 0;  // partida real; la PENDENT pesa molt més
    const score = a.s + b.s + pend;
    if (!best || score > best.score) best = { a: a.p, b: b.p, score };
  }
  if (best) return [best.a, best.b];
  // Cap parella del mateix grup entre els candidats → un sol costat fiable:
  // dedueix el rival pel grup (partida pendent única).
  for (const { p } of cs) {
    const opp = opponentInGroup(p.name, omatches, oplayers);
    if (opp && !canonEq(opp.name, p.name)) return [p, opp];
  }
  return cs.length ? [cs[0].p, null] : null;
}

function grabFrames(videoId, n, intervalSec, tmpDir) {
  // YouTube bloqueja les IPs de datacenter (GitHub Actions) demanant login; amb
  // un fitxer de cookies (YT_COOKIES) yt-dlp s'autentica i ho evita.
  const ck = process.env.YT_COOKIES ? ['--cookies', process.env.YT_COOKIES] : [];
  let hls;
  try {
    // --remote-components ejs:github: baixa el script solucionador del repte "n"
    // (nsig) de YouTube, que el yt-dlp nou no baixa per defecte; amb Deno + el
    // PO-token, completa la baixada de frames a GitHub SENSE cookies.
    // TIMEOUT imprescindible: si yt-dlp es penja, el worker no s'encalla.
    // --match-filter is_live: només extreu si el vídeo està EN DIRECTE ARA; un VOD
    // o directe acabat (encara amb el badge LIVE enganxat a /streams) es filtra i
    // no en llegim un marcador antic. Fiable a GitHub (yt-dlp via PO-token).
    hls = execFileSync('yt-dlp', ['-f', 'best[height<=720]/best', '--match-filter', 'is_live', '--remote-components', 'ejs:github', ...ck, '-g', `https://www.youtube.com/watch?v=${videoId}`], { encoding: 'utf8', timeout: 60000 }).split('\n')[0].trim();
  } catch { return []; }
  if (!hls) return [];
  const pat = path.join(tmpDir, `${videoId}_%03d.jpg`);
  // Timeout també a ffmpeg (lectura de l'HLS en viu): si es penja, no bloqueja.
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', hls, '-vf', `fps=1/${intervalSec}`, '-frames:v', String(n), pat], { timeout: 90000 });
  return fs.readdirSync(tmpDir).filter((f) => f.startsWith(`${videoId}_`)).map((f) => path.join(tmpDir, f));
}

function mode(arr) {
  const c = {};
  for (const x of arr) if (x != null && x !== '') c[x] = (c[x] || 0) + 1;
  const e = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return e ? e[0] : null;
}

function consensus(reads) {
  const valid = reads.filter((r) => r && r.found && Number.isInteger(r.car_left) && Number.isInteger(r.car_right));
  if (valid.length < 2) return null;
  const key = (r) => `${r.car_left}|${r.car_right}`;
  const counts = {};
  for (const r of valid) counts[key(r)] = (counts[key(r)] || 0) + 1;
  const [bestKey, agree] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (agree < 2) return null; // cal almenys 2 fotogrames que coincideixin
  const [cl, cr] = bestKey.split('|').map(Number);
  const agreeing = valid.filter((r) => key(r) === bestKey);
  const entMode = mode(agreeing.map((r) => r.entrades).filter(Number.isInteger).map(String));
  return {
    car_left: cl, car_right: cr,
    entrades: entMode != null ? Number(entMode) : null,
    name_left: mode(agreeing.map((r) => r.name_left)),
    name_right: mode(agreeing.map((r) => r.name_right)),
    agree, total: valid.length,
  };
}

// Debounce de REINICI de marcador: una caiguda brusca a ~0 amb els MATEIXOS
// jugadors és, gairebé sempre, un VOD/replay que s'ha colat o un directe reiniciat
// (no una partida nova: una de nova porta jugadors diferents). No ens ho creiem a
// l'instant —ni amb consens fort, que un VOD dona 5/5 estable a 0-0— sinó que
// mantenim el marcador alt previ fins que el reinici PERSISTEIXI ~5 min. El moment
// del primer reinici es desa a la columna `reset_pending_at` (BD), de manera que el
// debounce SOBREVIU als reinicis del worker (robustesa total).
const RESET_GRACE_MS = 5 * 60 * 1000;  // cal que el 0-0 duri 5 min abans d'acceptar-lo

async function runOnce({ samples = 5, interval = 3, log = console.error } = {}) {
  await ensureReader(log);
  const opens = await supa('GET', 'open_live', { query: '?select=fcb_division_id,name,payload_json' });
  // Marcadors previs (per la guarda monotònica: les caramboles no baixen).
  let prevByVid = {};
  try {
    const prevRows = await supa('GET', 'open_live_scores', { query: '?select=video_id,player_a,player_b,car_a,car_b,entrades,reset_pending_at' });
    for (const r of prevRows || []) prevByVid[r.video_id] = r;
  } catch { /* primera vegada */ }
  const nowIso = new Date().toISOString();
  const liveVideoIds = [];
  let published = 0;

  for (const open of opens || []) {
    const tokens = venueTokens(open.payload_json);
    if (!tokens.length) continue;
    const ot = openToken(open.name);
    log(`\n# ${open.name} (#${open.fcb_division_id}) seus=${tokens.join(', ')}`);
    let streams = [];
    try { streams = await liveStreamsForTokens(tokens, { onLog: () => {} }); } catch (e) { log(`  ! streams: ${e.message}`); continue; }
    // Només streams el títol dels quals confirma aquest open (paraula distintiva,
    // tolerant a abreujatures com "C. DAURADA" en lloc de "COSTA DAURADA").
    streams = streams.filter((s) => titleMatchesOpen(s.title, ot));
    log(`  ${streams.length} directes d'aquest open`);
    const oplayers = openPlayers(open.payload_json);
    const omatches = openMatches(open.payload_json);

    for (const s of streams) {
      liveVideoIds.push(s.videoId);
      const tp = parseTitle(s.title);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wk_'));
      try {
        const frames = grabFrames(s.videoId, samples, interval, tmp);
        const reads = [];
        for (const f of frames) { try { const rr = await _readFrame(f); if (rr) reads.push(rr); } catch { /* skip */ } }
        const c = consensus(reads);
        if (!c) {
          // Sense marcador llegible. Si són frames de RELLOTGE (escalfament/pausa)
          // i el TÍTOL identifica els dos jugadors, publiquem la partida com EN JOC
          // sense resultat (escalfament) perquè es vegi i s'hi pugui anar al directe.
          const clockish = reads.filter((r) => r && r.state === 'clock').length >= 2;
          const w0 = resolvePlayer(tp.players[0], oplayers);
          const w1 = resolvePlayer(tp.players[1], oplayers);
          if (clockish && w0 && w1 && w0.name !== w1.name) {
            const wg = matchGroup(w0.name, w1.name, oplayers) || tp.group || w0.group || w1.group || null;
            await supa('POST', 'open_live_scores', { body: [{
              video_id: s.videoId, fcb_division_id: open.fcb_division_id, club: tokens[0],
              title: s.title, phase: tp.phase, group_label: wg,
              player_a: w0.name, player_b: w1.name, car_a: null, car_b: null, entrades: null,
              captured_at: nowIso, updated_at: nowIso, reset_pending_at: null,
            }], upsert: true });
            published++;
            log(`  ◴ [${wg || '?'}] ${w0.name} (escalfament) ${w1.name}`);
          } else {
            log(`  ~ ${s.videoId} sense consens (${reads.filter((r) => r?.found).length}/${frames.length} llegits) — ${tp.players.join(' vs ')}`);
          }
          continue;
        }

        // Routing: resol la PARELLA amb les pistes de l'OCR i del títol, imposant
        // que els dos jugadors siguin del MATEIX grup i preferint la partida
        // pendent (regles de l'usuari). Després assignem esquerra/dreta segons quin
        // costat de l'overlay casa amb cada jugador (per a les caramboles).
        const pair = resolvePairing([c.name_left, c.name_right, tp.players[0], tp.players[1]], oplayers, omatches);
        if (!pair) { log(`  ~ ${s.videoId} no s'ha identificat cap jugador (${c.name_left}/${c.name_right})`); continue; }
        let [pL, pR] = pair;
        if (pL && pR) {
          // Orientació: la combinació que maximitza l'acord amb l'OCR mana.
          const keep = scoreName(c.name_left, pL) + scoreName(c.name_right, pR);
          const swap = scoreName(c.name_left, pR) + scoreName(c.name_right, pL);
          if (swap > keep) { const t = pL; pL = pR; pR = t; }
        }
        if (!pL && !pR) { log(`  ~ ${s.videoId} no s'ha identificat cap jugador (${c.name_left}/${c.name_right})`); continue; }
        const group = (pL && pR && matchGroup(pL.name, pR.name, oplayers)) || tp.group || pL?.group || pR?.group || null;

        const row = {
          video_id: s.videoId, fcb_division_id: open.fcb_division_id, club: tokens[0],
          title: s.title, phase: tp.phase, group_label: group,
          player_a: pL ? pL.name : null,
          player_b: pR ? pR.name : null,
          car_a: c.car_left, car_b: c.car_right, entrades: c.entrades,
          captured_at: nowIso, updated_at: nowIso,
          reset_pending_at: null,  // per defecte cap reinici pendent (l'upsert sempre l'escriu)
        };
        const prev = prevByVid[s.videoId];
        // CONTINUÏTAT (mateixa partida): cal que coincideixin ELS DOS jugadors (la
        // parella), no només un — a la mateixa taula el RIVAL ROTA entre partides
        // (p.ex. JOU juga successivament amb FERNÁNDEZ i amb MARTÍNEZ). Si un costat
        // ha quedat sense resoldre però l'altre casa amb prev, ho considerem
        // continuació (rival momentàniament il·legible) i conservem la identitat.
        const _newSet = [row.player_a, row.player_b].filter(Boolean).map(_canon);
        const _prevSet = [prev?.player_a, prev?.player_b].filter(Boolean).map(_canon);
        const _common = _newSet.filter((n) => _prevSet.includes(n)).length;
        const _incomplete = !row.player_a || !row.player_b;
        const samePair = !!prev && _prevSet.length >= 2 && (_common >= 2 || (_incomplete && _common >= 1));
        if (samePair) {
          // Els NOMS i els COSTATS no canvien (càmera fixa), les CARAMBOLES només
          // creixen i les ENTRADES també. Si la lectura ve girada respecte prev,
          // desfem el gir de les caramboles.
          const flipped = (canonEq(prev.player_a, row.player_b) || canonEq(prev.player_b, row.player_a))
                       && !(canonEq(prev.player_a, row.player_a) || canonEq(prev.player_b, row.player_b));
          if (flipped) { const t = row.car_a; row.car_a = row.car_b; row.car_b = t; }
          if (prev.player_a) row.player_a = prev.player_a;
          if (prev.player_b) row.player_b = prev.player_b;
          // Un consens FORT (≥3 frames d'acord) pot CORREGIR un pic fals anterior
          // (p.ex. un "2" llegit de forma estable com a "7" durant una passada):
          // sense això, un sol misread local s'enganxaria per sempre, perquè la
          // monotonia rebutjaria totes les lectures correctes posteriors (menors).
          const strong = c.agree >= 3;
          // REINICI BRUSC (probable VOD/replay colat o directe reiniciat): caiguda
          // forta de caramboles o tornada a ~0. NO l'acceptem a l'instant (ni amb
          // consens fort); mantenim el marcador alt previ fins que persisteixi ~5 min.
          const bigReset = prev.car_a != null && (
            (prev.car_a - row.car_a) + (prev.car_b - row.car_b) >= 4 ||
            (row.car_a <= 1 && row.car_b <= 1 && (prev.car_a + prev.car_b) >= 5)
          );
          if (bigReset) {
            // `since` ve de la BD (reset_pending_at) → el debounce sobreviu als
            // reinicis del worker. Si encara no n'hi havia, l'iniciem ARA i el desem.
            const since = prev.reset_pending_at ? Date.parse(prev.reset_pending_at) : null;
            if (since && Date.now() - since >= RESET_GRACE_MS) {
              row.reset_pending_at = null;     // persisteix >5 min → reinici real/partida nova: acceptem
              log(`  ↺ [${group || '?'}] reinici acceptat (persisteix >5min) ${row.player_a} ${row.car_a}-${row.car_b}`);
            } else {
              row.car_a = prev.car_a; row.car_b = prev.car_b;        // mantenim l'alt
              if (prev.entrades != null) row.entrades = prev.entrades;
              row.reset_pending_at = prev.reset_pending_at || nowIso; // conserva el primer cop vist
              const waited = since ? Math.round((Date.now() - since) / 1000) : 0;
              log(`  ⏸ [${group || '?'}] possible VOD/reinici ${prev.car_a}-${prev.car_b}→${c.car_left}-${c.car_right}: mantinc l'alt (${waited}/${RESET_GRACE_MS / 1000}s)`);
            }
          } else {
            // lectura coherent → fora candidat a reinici (row.reset_pending_at ja és null)
            // Entrades sempre creixents: si la lectura baixa, és error → mantenim
            // (tret de consens fort, que pot desfer un pic fals d'entrades).
            if (prev.entrades != null && (row.entrades == null || row.entrades < prev.entrades) && !strong) {
              row.entrades = prev.entrades;
            }
            // Caramboles no decreixen (correcció d'àrbitre → tolerància ±1), tret de
            // consens fort (correcció d'un pic fals petit).
            if (prev.car_a != null && !strong && (row.car_a < prev.car_a - 1 || row.car_b < prev.car_b - 1)) {
              log(`  ⤫ [${group || '?'}] ${row.player_a} ${row.car_a}-${row.car_b} (descens vs ${prev.car_a}-${prev.car_b}) → ignorat`);
              continue;
            }
          }
        }
        await supa('POST', 'open_live_scores', { body: [row], upsert: true });
        published++;
        log(`  ✓ [${group || '?'}] ${row.player_a} ${c.car_left}-${c.car_right} ${row.player_b} (ocr ${c.name_left}/${c.name_right}, consens ${c.agree}/${c.total})`);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  }

  // Retira marcadors de directes que ja no emeten.
  const keep = liveVideoIds.length ? `(${liveVideoIds.map((v) => `"${v}"`).join(',')})` : '("")';
  try {
    const removed = await supa('DELETE', 'open_live_scores', { query: `?video_id=not.in.${keep}`, body: null });
    log(`\nPublicats: ${published} · retirats: ${(removed || []).length}`);
  } catch (e) { log(`Neteja fallida: ${e.message}`); }
  // Poda de files OBSOLETES: directes que segueixen actius però fa estona que no
  // donen lectura fiable (pausa/escalfament perllongats) → no mantenir valors vells.
  try {
    const staleCut = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    await supa('DELETE', 'open_live_scores', { query: `?updated_at=lt.${encodeURIComponent(staleCut)}` });
  } catch { /* noop */ }
  return { published, live: liveVideoIds.length };
}

// Bucle intern: manté el sidecar PaddleOCR viu entre passades (el model es
// carrega un sol cop). El workflow crida `node ... --loop` UN COP, en lloc de
// re-invocar node cada vegada (que recarregaria el model a cada passada).
async function runLoop({ samples = 5, intervalSec = 8, maxSec = 21000 } = {}) {
  await ensureReader(console.error);
  const end = Date.now() + maxSec * 1000;
  let i = 0;
  while (Date.now() < end) {
    i++;
    console.error(`\n::: passada #${i} :::`);
    try { await runOnce({ samples }); } catch (e) { console.error('pass err', e.message); }
    if (Date.now() < end) await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
  closeReaders();
}

module.exports = { runOnce, runLoop, parseTitle, consensus };

if (require.main === module) {
  const samples = Number((process.argv.find((a) => a.startsWith('--samples=')) || '').split('=')[1]) || 5;
  if (process.argv.includes('--loop')) {
    runLoop({ samples }).catch((e) => { console.error('ERR', e.message); process.exit(1); });
  } else {
    runOnce({ samples }).then((r) => console.error('FET', JSON.stringify(r))).finally(() => closeReaders());
  }
}
