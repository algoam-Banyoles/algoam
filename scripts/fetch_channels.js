const fs = require('fs/promises');
const url = 'https://www.fcbillar.cat/ca/info/view/s/5/Federacio/i/11/fcbstreaming/c/0/0';

async function main() {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch page: ${res.status}`);
  const html = await res.text();

  const channelRegex = /UC[\w-]{22}/g;
  const sections = html.split(/<iframe/); // crude splitting around iframes
  const channels = [];

  for (const section of sections) {
    const idMatch = section.match(channelRegex);
    if (!idMatch) continue;
    const channelId = idMatch[0];
    const before = section.split('>')[0];
    const nameMatch = before.match(/title="([^"]+)"/i) || before.match(/alt="([^"]+)"/i);
    let name = nameMatch ? nameMatch[1].trim() : '';
    if (!name) {
      // fallback: look for text content before iframe
      const prevText = html.substring(html.lastIndexOf('</', html.indexOf(section)) - 100, html.lastIndexOf('<', html.indexOf(section))).replace(/<[^>]*>/g, '').trim();
      if (prevText) name = prevText.split('\n').pop().trim();
    }
    if (!name) name = channelId;
    channels.push({ name, channelId });
  }

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
