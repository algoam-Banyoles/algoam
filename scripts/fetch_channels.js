const fs = require('fs/promises');
const cheerio = require('cheerio');

const url = 'https://www.fcbillar.cat/ca/info/view/s/5/Federacio/i/11/fcbstreaming/c/0/0';

async function main() {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch page: ${res.status}`);
  const html = await res.text();

  const $ = cheerio.load(html);
  const channelMap = new Map();

  $('a[href*="youtube.com"], iframe[src*="youtube.com"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || $el.attr('src') || '';

    const idMatch = href.match(/(UC[\w-]{22})/);
    const handleMatch = href.match(/youtube\.com\/(@[\w-]+)/);
    if (!idMatch && !handleMatch) return;
    const channelId = idMatch ? idMatch[1] : null;
    const handle = handleMatch ? handleMatch[1] : null;

    let name = ($el.text() || '').trim();
    if (!name) name = $el.attr('title') || $el.attr('alt') || channelId || handle;

    const key = channelId || handle;
    const current = channelMap.get(key) || {};
    channelMap.set(key, {
      name,
      channelId: channelId || current.channelId,
      handle: handle || current.handle,
    });
  });

  async function fetchHandle(channelId) {
    const res = await fetch(`https://www.youtube.com/channel/${channelId}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch channel page: ${res.status}`);
    }
    const page = await res.text();
    const match = page.match(/"canonicalUrl":"https:\/\/www\.youtube\.com\/(@[^"]+)"/);
    if (match) return match[1];
    const match2 = page.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/(@[^"]+)"/);
    return match2 ? match2[1] : null;
  }

  for (const ch of channelMap.values()) {
    if (!ch.handle && ch.channelId) {
      try {
        ch.handle = await fetchHandle(ch.channelId);
      } catch (err) {
        console.warn(`Could not resolve handle for ${ch.channelId}: ${err.message}`);
      }
    }
  }

  const channels = Array.from(channelMap.values());


  if (channels.length === 0) {
    console.warn('No channels found. The page structure may have changed.');
  }

  await fs.writeFile('canals.json', JSON.stringify(channels, null, 2));
  console.log(`Wrote ${channels.length} channels to canals.json`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
