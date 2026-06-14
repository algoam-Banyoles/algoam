// Pont Node → sidecar PaddleOCR (scripts/paddle_scoreboard.py --serve).
// Arrenca el procés Python UN COP (el model es carrega una sola vegada) i hi
// envia camins de frame, rebent {found,state,car_left,car_right,entrades,
// name_left,name_right} per cada un. Si el sidecar no arrenca, el worker pot
// continuar amb tesseract com a alternativa.
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

let proc = null, rl = null, ready = false;
const readyWaiters = [];
const queue = []; // resolucions FIFO (Python respon en ordre)

function pythonPath() {
  // venv local de Windows o Linux; si no, 'python3'/'python' del PATH.
  const cands = [
    path.join(__dirname, '..', '.venv-paddle', 'Scripts', 'python.exe'),
    path.join(__dirname, '..', '.venv-paddle', 'bin', 'python'),
    process.env.PADDLE_PYTHON,
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function start({ onLog = () => {} } = {}) {
  if (proc) return;
  const script = path.join(__dirname, 'paddle_scoreboard.py');
  proc = spawn(pythonPath(), [script, '--serve'], {
    env: { ...process.env, FLAGS_use_mkldnn: '0', PYTHONIOENCODING: 'utf-8' },
  });
  rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    if (obj && obj.ready && !ready) {
      ready = true;
      readyWaiters.splice(0).forEach((w) => w.resolve());
      return;
    }
    const cb = queue.shift();
    if (cb) cb(obj);
  });
  let errbuf = '';
  proc.stderr.on('data', (d) => { errbuf = (errbuf + d).slice(-2000); });
  proc.on('exit', (code) => {
    onLog(`paddle sidecar tancat (code=${code})`);
    proc = null; ready = false;
    queue.splice(0).forEach((cb) => cb(null));
    readyWaiters.splice(0).forEach((w) => w.reject(new Error('paddle exit ' + code + ': ' + errbuf.slice(-300))));
  });
}

function waitReady(timeoutMs = 120000) {
  if (ready) return Promise.resolve();
  if (!proc) return Promise.reject(new Error('paddle sidecar no arrencat'));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('paddle ready timeout')), timeoutMs);
    readyWaiters.push({ resolve: () => { clearTimeout(t); resolve(); }, reject: (e) => { clearTimeout(t); reject(e); } });
  });
}

function read(framePath, timeoutMs = 30000) {
  if (!proc || !ready) return Promise.resolve(null);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    queue.push((obj) => { clearTimeout(t); resolve(obj); });
    proc.stdin.write(framePath + '\n');
  });
}

function close() { try { if (proc) { proc.stdin.write('__quit__\n'); proc.kill(); } } catch { /* noop */ } proc = null; ready = false; }

module.exports = { start, waitReady, read, close };
