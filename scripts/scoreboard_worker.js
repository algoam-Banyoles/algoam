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

// Totes les partides dels grups (de open_live): [{a, b, group, played}].
function openMatches(payload) {
  const out = [];
  for (const ph of payload?.phases || []) for (const g of ph.groups || []) for (const m of g.matches || []) {
    if (m.player_a && m.player_b) out.push({ a: m.player_a, b: m.player_b, group: g.label, played: !!m.is_played });
  }
  return out;
}

// Quan un costat no resol, dedueix el rival: si el jugador conegut té UNA sola
// partida del grup pendent (o una de sola en total), el rival és l'altre.
function opponentInGroup(name, matches, players) {
  const inv = matches.filter((m) => sameName(m.a, name) || sameName(m.b, name));
  const pending = inv.filter((m) => !m.played);
  const pool = pending.length === 1 ? pending : (inv.length === 1 ? inv : []);
  if (pool.length !== 1) return null;
  const oppName = sameName(pool[0].a, name) ? pool[0].b : pool[0].a;
  return players.find((p) => p.name === oppName) || { name: oppName, group: pool[0].group };
}

function grabFrames(videoId, n, intervalSec, tmpDir) {
  // YouTube bloqueja les IPs de datacenter (GitHub Actions) demanant login; amb
  // un fitxer de cookies (YT_COOKIES) yt-dlp s'autentica i ho evita.
  const ck = process.env.YT_COOKIES ? ['--cookies', process.env.YT_COOKIES] : [];
  let hls;
  try {
    hls = execFileSync('yt-dlp', ['-f', 'best[height<=720]/best', ...ck, '-g', `https://www.youtube.com/watch?v=${videoId}`], { encoding: 'utf8' }).split('\n')[0].trim();
  } catch { return []; }
  if (!hls) return [];
  const pat = path.join(tmpDir, `${videoId}_%03d.jpg`);
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', hls, '-vf', `fps=1/${intervalSec}`, '-frames:v', String(n), pat]);
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

async function runOnce({ samples = 5, interval = 3, log = console.error } = {}) {
  await ensureReader(log);
  const opens = await supa('GET', 'open_live', { query: '?select=fcb_division_id,name,payload_json' });
  // Marcadors previs (per la guarda monotònica: les caramboles no baixen).
  let prevByVid = {};
  try {
    const prevRows = await supa('GET', 'open_live_scores', { query: '?select=video_id,player_a,player_b,car_a,car_b,entrades' });
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
    // Només streams el títol dels quals confirma aquest open.
    streams = streams.filter((s) => !ot || norm(s.title).includes(ot));
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
        if (!c) { log(`  ~ ${s.videoId} sense consens (${reads.filter((r) => r?.found).length}/${frames.length} llegits) — ${tp.players.join(' vs ')}`); continue; }

        // Routing: resol cada costat contra els jugadors reals de l'open. El
        // costat esquerre/dret de l'overlay mana per a les caramboles. Mai dos
        // cops el mateix jugador; ordre de preferència: resolt → títol → OCR.
        const t0 = resolvePlayer(tp.players[0], oplayers);
        const t1 = resolvePlayer(tp.players[1], oplayers);
        let pL, pR;
        if (t0 && t1 && t0.name !== t1.name) {
          // Títol FIABLE: ja tenim els dos jugadors. L'OCR només decideix quin és
          // a l'esquerra i quin a la dreta del marcador (per a les caramboles).
          const ocrL = resolvePlayer(c.name_left, [t0, t1]);
          const ocrR = resolvePlayer(c.name_right, [t0, t1]);
          const swap = (ocrL && ocrL.name === t1.name) || (ocrR && ocrR.name === t0.name);
          pL = swap ? t1 : t0;
          pR = swap ? t0 : t1;
        } else {
          // Títol genèric (p.ex. "TAULA N"): OCR de noms + deducció pel grup.
          pL = resolvePlayer(c.name_left, oplayers);
          pR = resolvePlayer(c.name_right, oplayers);
          if (pL && pR && pL.name === pR.name) pR = null;
          if (!pR && pL) { const o = opponentInGroup(pL.name, omatches, oplayers); if (o && o.name !== pL.name) pR = o; }
          if (!pL && pR) { const o = opponentInGroup(pR.name, omatches, oplayers); if (o && o.name !== pR.name) pL = o; }
        }
        if (!pL && !pR) { log(`  ~ ${s.videoId} no s'ha identificat cap jugador (${c.name_left}/${c.name_right})`); continue; }
        const group = tp.group || pL?.group || pR?.group || null;

        const row = {
          video_id: s.videoId, fcb_division_id: open.fcb_division_id, club: tokens[0],
          title: s.title, phase: tp.phase, group_label: group,
          player_a: pL ? pL.name : null,
          player_b: pR ? pR.name : null,
          car_a: c.car_left, car_b: c.car_right, entrades: c.entrades,
          captured_at: nowIso, updated_at: nowIso,
        };
        const prev = prevByVid[s.videoId];
        if (prev && (sameName(prev.player_a, row.player_a) || sameName(prev.player_b, row.player_b)
                  || sameName(prev.player_a, row.player_b) || sameName(prev.player_b, row.player_a))) {
          // MATEIXA PARTIDA (regles de l'usuari): els NOMS i els COSTATS no canvien
          // (càmera fixa), les CARAMBOLES només creixen i les ENTRADES també.
          // Mantenim la identitat de prev i hi alineem aquesta lectura; si ve
          // girada respecte prev, desfem el gir de les caramboles.
          const flipped = (sameName(prev.player_a, row.player_b) || sameName(prev.player_b, row.player_a))
                       && !(sameName(prev.player_a, row.player_a) || sameName(prev.player_b, row.player_b));
          if (flipped) { const t = row.car_a; row.car_a = row.car_b; row.car_b = t; }
          if (prev.player_a) row.player_a = prev.player_a;
          if (prev.player_b) row.player_b = prev.player_b;
          // Un consens FORT (≥3 frames d'acord) pot CORREGIR un pic fals anterior
          // (p.ex. un "2" llegit de forma estable com a "7" durant una passada):
          // sense això, un sol misread local s'enganxaria per sempre, perquè la
          // monotonia rebutjaria totes les lectures correctes posteriors (menors).
          const strong = c.agree >= 3;
          // Entrades sempre creixents: si la lectura baixa, és error → mantenim
          // (tret de consens fort, que pot desfer un pic fals d'entrades).
          if (prev.entrades != null && (row.entrades == null || row.entrades < prev.entrades) && !strong) {
            row.entrades = prev.entrades;
          }
          // Caramboles no decreixen (correcció d'àrbitre → tolerància ±1), tret de
          // consens fort (correcció d'un pic fals).
          if (prev.car_a != null && !strong && (row.car_a < prev.car_a - 1 || row.car_b < prev.car_b - 1)) {
            log(`  ⤫ [${group || '?'}] ${row.player_a} ${row.car_a}-${row.car_b} (descens vs ${prev.car_a}-${prev.car_b}) → ignorat`);
            continue;
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
async function runLoop({ samples = 5, intervalSec = 25, maxSec = 21000 } = {}) {
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
