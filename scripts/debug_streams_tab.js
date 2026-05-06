// Diagnostic helper: download a channel's /streams page and dump what
// the *selected* streams tab actually contains — counts of videoIds vs
// time-status overlays (LIVE / UPCOMING / DEFAULT for past lives).
// Usage: node scripts/debug_streams_tab.js <channelId>

const fs = require('fs');

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Cookie': 'CONSENT=YES+1',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  return res.text();
}

function extractYtInitialData(html) {
  const idx = html.indexOf('ytInitialData');
  if (idx < 0) return null;
  const start = html.indexOf('{', idx);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  return null;
}

(async () => {
  const cid = process.argv[2];
  if (!cid) { console.error('usage: debug_streams_tab.js <channelId>'); process.exit(1); }
  const html = await fetchPage(`https://www.youtube.com/channel/${cid}/streams`);
  const data = extractYtInitialData(html);
  if (!data) { console.log('no ytInitialData'); return; }
  const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
  for (const t of tabs) {
    const tab = t.tabRenderer || t.expandableTabRenderer;
    if (!tab) continue;
    const title = tab.title || tab.endpoint?.commandMetadata?.webCommandMetadata?.url || '';
    const selected = !!tab.selected;
    console.log(`TAB: "${title}" selected=${selected}`);
    if (!selected) continue;
    const json = JSON.stringify(tab.content);
    const videoIds = (json.match(/"videoId":"([\w-]{11})"/g) || []).length;
    const overlays = json.match(/"thumbnailOverlayTimeStatusRenderer":\{"text":\{[^}]+\}[^}]*"style":"\w+"/g) || [];
    console.log(`  videoId occurrences: ${videoIds}`);
    console.log(`  time-status overlays: ${overlays.length}`);
    const styles = {};
    for (const o of overlays) {
      const m = o.match(/"style":"(\w+)"/);
      const s = m ? m[1] : 'NONE';
      styles[s] = (styles[s] || 0) + 1;
    }
    console.log('  style histogram:', styles);
    // Try to grab the publishedTimeText for first few
    const ptt = (json.match(/"publishedTimeText":\{[^}]+\}/g) || []).slice(0, 5);
    for (const p of ptt) console.log('  ', p.slice(0, 120));
    // Detect the "messageRenderer" empty state
    if (json.includes('messageRenderer')) {
      const m = json.match(/"messageRenderer":\{[^}]+"text":[^}]+\}/);
      if (m) console.log('  empty-state message present');
    }
  }
})();
