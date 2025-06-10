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
    if (!idMatch) return;
    const channelId = idMatch[1];

    let name = ($el.text() || '').trim();
    if (!name) name = $el.attr('title') || $el.attr('alt') || channelId;

    channelMap.set(channelId, name);
  });

  const channels = Array.from(channelMap.entries()).map(([channelId, name]) => ({ name, channelId }));


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
