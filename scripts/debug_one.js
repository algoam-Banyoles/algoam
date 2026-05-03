function extractInitialPlayerResponse(html) {
  const idx = html.indexOf('ytInitialPlayerResponse');
  if (idx < 0) return null;
  const startBrace = html.indexOf('{', idx);
  if (startBrace < 0) return null;
  let depth = 0, inString = false, escape = false;
  for (let i = startBrace; i < html.length; i++) {
    const c = html[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(startBrace, i + 1)); }
        catch (e) { return null; }
      }
    }
  }
  return null;
}

async function main() {
  const arg = process.argv[2];
  const target = arg.startsWith('@')
    ? `https://www.youtube.com/${arg}/live`
    : `https://www.youtube.com/channel/${arg}/live`;
  const url = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(target)}`;
  console.log(`Fetching ${url}`);
  const res = await fetch(url, { redirect: 'follow', headers: { 'Accept-Language': 'en-US,en;q=0.9' } });
  console.log(`Status: ${res.status}`);
  const html = await res.text();
  console.log(`HTML length: ${html.length}`);
  const ipr = extractInitialPlayerResponse(html);
  if (!ipr) { console.log('NO ipr'); return; }
  const vd = ipr.videoDetails || {};
  const sd = ipr.streamingData;
  const lbd = ipr.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
  console.log('videoId:', vd.videoId, '| title:', vd.title);
  console.log('isLive:', vd.isLive, '| isUpcoming:', vd.isUpcoming);
  console.log('isLiveNow:', lbd?.isLiveNow);
  console.log('hlsManifestUrl:', !!sd?.hlsManifestUrl);
  console.log('playabilityStatus:', ipr.playabilityStatus?.status);
}

main().catch(err => console.error(err));
