// Re-marca els canals: FCB ja està fet, ara afegim RFEB als clubs i
// federacions espanyoles que no són catalans, i deixem la resta sense
// camp federation (queden a "Internacionals" a la UI).

const fs = require('fs');
const path = require('path');

const RFEB_CHANNEL_IDS = new Set([
  // Federacions
  'UCBHlmC1BslTR5tOTycMBO1Q', // Real Federación Española
  'UC6qfDztDBxTlno-lnk_CSiw', // Federación Andaluza
  'UCdYu6HdiSdmnMutvyRV-tSA', // Federació Valenciana
  // Madrid
  'UCzAcYT_zYeb51V5KnrdYjHg', // Madrid Escuela
  'UCMe7BWxuJs9nPYcDbS04gPA', // FMB Vallecas Madrid
  'UClPb3P4bHQkhWvtBuaXwCNg', // Móstoles
  // Andalusia
  'UC5mkH_KKWXeMgRoF-Zlgo4w', // Sevilla
  'UCggG8KvDjLs2LhDB8TuAy1g', // Maracena 2
  'UC_h9zs9B6FcpO_HXmjU7e5A', // Maracena 3
  'UCe43sIim4alLSvfaXK1IEeQ', // Úbeda
  'UClZHBalhAdDiA_6iP61l4sA', // Nerva
  'UCuumNJ6s3fFg9nxEjJNvtjA', // Córdoba
  'UCwHJwOaQ2qtOfC1seSY659Q', // Benacazón
  'UC-YPd10q3SECGxyDpmvug-g', // Mijas
  'UCkvCZqymisfM0F16Sm3349w', // Ayamonte
  'UCowNjyJZVYi7AqUwvoDxJqw', // Baeza
  // València i Múrcia
  'UC4dwMUmaD1I9d7PDeZw48gw', // Valencia
  'UCO0I4CwABojhuotU8jPZzoA', // Valencia 1
  'UCwQ7_xtpVbhvyshqu30OgVA', // Valencia 4
  'UC9R5N-UrYcxW-FCYdmhdqAA', // Paiporta 1
  'UCdEcGjFQJp5V0iJ2VgtnQlA', // Paiporta 2
  'UC1DBNANfxHKPq6iGQvdVxwg', // Sueca
  'UCByss4QQnxZd-kBmNeJT5RA', // Novelda
  'UCEK4JIyVW7OEJSKjMzxJHmg', // Caravaca
  'UCAwhAr0UJrAOFQKAAilRhEg', // Alcalá
  'UCn3bwzP8wihXAkBaN_hbUTA', // Gandia
  // Castella i Lleó
  'UCYG3UOPIDT2E0lLxW3bHkQw', // Valladolid
  // Balears
  'UCSPKJtODPJQNByDOPimZeRw', // Palma
]);

const canalsPath = path.join(__dirname, '..', 'canals.json');
const canals = JSON.parse(fs.readFileSync(canalsPath, 'utf8'));

let rfebCount = 0;
let fcbCount = 0;
let intlCount = 0;
const updated = canals.map(c => {
  const out = { ...c };
  if (out.federation === 'FCB') {
    fcbCount++;
    return out;
  }
  if (RFEB_CHANNEL_IDS.has(out.channelId)) {
    out.federation = 'RFEB';
    rfebCount++;
  } else {
    delete out.federation;
    intlCount++;
  }
  return out;
});

fs.writeFileSync(canalsPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
console.log(`FCB: ${fcbCount}, RFEB: ${rfebCount}, Internacionals: ${intlCount}, total: ${updated.length}`);
