// Debug helper: fetch a channel's /live page through codetabs proxy,
// extract ytInitialPlayerResponse, and dump the relevant detection fields.
// Usage: node scripts/debug_one.js @handle [--direct]

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
        catch (e) { return { __parseError: e.message }; }
      }
    }
  }
  return null;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node scripts/debug_one.js <@handle|UCchannelId> [--direct]');
    process.exit(1);
  }
  const direct = process.argv.includes('--direct');
  const target = arg.startsWith('@')
    ? `https://www.youtube.com/${arg}/live`
    : `https://www.youtube.com/channel/${arg}/live`;
  const url = direct ? target : `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(target)}`;
  console.log(`Fetching ${url}`);
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  console.log(`Status: ${res.status}, final URL: ${res.url}`);
  const html = await res.text();
  console.log(`HTML length: ${html.length}`);

  const ipr = extractInitialPlayerResponse(html);
  if (!ipr) {
    console.log('NO ytInitialPlayerResponse extracted');
    console.log('  contains marker:', html.includes('ytInitialPlayerResponse'));
    console.log('  first 500 chars:', html.slice(0, 500));
    return;
  }
  if (ipr.__parseError) {
    console.log('JSON parse error:', ipr.__parseError);
    return;
  }
  const vd = ipr.videoDetails || {};
  const lbd = ipr.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
  const sd = ipr.streamingData;
  console.log('videoId:', vd.videoId, '| title:', vd.title);
  console.log('isLive:', vd.isLive, '| isUpcoming:', vd.isUpcoming, '| isLiveContent:', vd.isLiveContent);
  console.log('isLiveNow:', lbd?.isLiveNow);
  console.log('hlsManifestUrl:', !!sd?.hlsManifestUrl, '| dashManifestUrl:', !!sd?.dashManifestUrl);
  console.log('playabilityStatus:', ipr.playabilityStatus?.status, '|', ipr.playabilityStatus?.reason);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
