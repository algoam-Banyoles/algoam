// One-shot: marca cada canal de canals.json amb el seu camp `federation`.
// Els clubs FCB es deriventen de tres senyals:
//   - channelId trobat al sitemap d'FCB (fcbillar.cat retransmissions)
//   - handle trobat al mateix sitemap
//   - nom amb prefix de club català conegut
// La resta queda sense camp `federation`, i la UI els posa al grup "Altres".

const fs = require('fs');
const path = require('path');

const FCB_CHANNEL_IDS = new Set([
  'UC33EaGjvEA92-jcWpL06_XQ', 'UC3UaoySxRFDKQPVjOiCTGpg', 'UC4QKXDKnDqnQ31_YG5yvdDg',
  'UC5EMAWwvg_1gsVrqEWlpixw', 'UC6glMfOX3W3GzVDGenn-cfQ', 'UC8TiwIIzS1vNHd1W0Z1lpuQ',
  'UC9xHdBNYXuj5CtbpXz28EiQ', 'UCEy8Kt3skfnGx3rv6TU1iHg', 'UCFfLvkS2hTIXop-r-wTlXcQ',
  'UCIozKc9Toz66y2am4-nWxAA', 'UCIy2d7-zhSNrQiJISbzKfLw', 'UCJk0IyN2gNficW43ZFFajxw',
  'UCNn1Tmh53ejJUXhfSDv3Hfg', 'UCOWby67o_7DONPFu1h9VgVg', 'UCOkHTGoB6MGivKS2DBcuTTQ',
  'UCPqOow5DLA1eFcj2ji8nmyw', 'UCSCI6PC7st_sIILtW3bdCvg', 'UCTZhhkh0po7TgRmJ6qy7UUw',
  'UCUe403LWY9NGRUAglIM2Lug', 'UCV4n0mgnRWigOksGnxnHtPw', 'UCk9YLBgxJVhWrsjLcrn7qwA',
  'UCnxFpglOqmIXLKPv6tf_q-g', 'UCoy0jInzaCfMTirQJTWRtlA', 'UCrJ-OEolzEnigssxldd4l1g',
  'UCsbBBXU9y7vyZeZboSGuKvQ', 'UCt1s0StHWo6oyawmmxmZASw', 'UCw4lTndxGlhu74xVbw8bkzg',
  'UCwLYL5CIFXXOqaS7kJly3gQ', 'UCx17qHHbTj0yXWKqBqN6B2A',
  // El propi canal de la FCB
  'UCdZUs67fC0R2LmzeB3XEWgg',
]);

const FCB_HANDLES = new Set([
  '@BorgesBillar1', '@BorgesBillar2', '@BorgesBillar3',
  '@ClubBillarBarcelona',
  '@ClubBillarCerdanyolaBill-oq6ri', '@ClubBillarCerdanyolaBill-wr6so', '@ClubBillarCerdanyolaBillar',
  '@ClubBillarllinars',
  '@Club_Billar_Barcelona_Taula_02', '@Club_Billar_Barcelona_Taula_03', '@Club_Billar_Barcelona_Taula_04',
  '@CoralColonBillar1', '@CoralColonBillar2', '@CoralColonBillar3', '@CoralColonBillar4',
  '@billar1mont-roig610', '@billar2mont-roig289', '@billar3mont-roig36',
  '@cbsantfeliu1', '@cbsantfeliu2', '@cbsantfeliu3',
  '@cerverabillar1', '@cerverabillar2', '@cerverabillar3', '@cerverabillar4',
  '@clubbillarsants-billar7', '@clubbillarsants-billar8',
  '@granollersbillar1', '@granollersbillar2', '@granollersbillar3', '@granollersbillar4',
  '@llicabillar1', '@llicabillar2',
]);

// Prefixos de nom per a clubs catalans no detectats al sitemap (Vic, Molins,
// Mataró, Canet i les noves entrades genèriques de FCB). Comparació
// case-insensitive amb el primer trosset del nom.
const FCB_NAME_PREFIXES = [
  'CLUB BILLAR BARCELONA',
  'CLUB BILLAR BORGES',
  'CLUB BILLAR SANT FELIU',
  "CLUB BILLAR LLICÀ",
  'BILLAR CLUB GRANOLLERS',
  'CORAL COLON BILLAR',
  'CLUB BILLAR MONT-ROIG',
  'CLUB BILLAR LLINARS',
  'CLUB BILLAR CERVERA',
  'CLUB BILLAR MONFORTE',
  'CLUB BILLAR SANTS',
  'CLUB BILLAR TARRAGONA',
  'CLUB BILLAR BANYOLES',
  'CLUB BILLAR MANRESA',
  'CLUB BILLAR CANET',
  'CLUB BILLAR LLEIDA',
  'CLUB BILLAR VIC',
  'CLUB BILLAR MOLINS',
  'CLUB BILLAR SANT ADRIA',
  'CLUB BILLAR MATARO',
  'CLUB BILLAR MATARÓ',
  'CLUB BILLAR CERDANYOLA',
  'FEDERACIÓ CATALANA',
];

function isFCB(c) {
  if (FCB_CHANNEL_IDS.has(c.channelId)) return true;
  if (c.handle && FCB_HANDLES.has(c.handle)) return true;
  const upper = (c.name || '').toUpperCase();
  return FCB_NAME_PREFIXES.some(p => upper.startsWith(p.toUpperCase()));
}

const canalsPath = path.join(__dirname, '..', 'canals.json');
const canals = JSON.parse(fs.readFileSync(canalsPath, 'utf8'));

let fcbCount = 0;
const updated = canals.map(c => {
  const out = { ...c };
  if (isFCB(c)) {
    out.federation = 'FCB';
    fcbCount++;
  }
  return out;
});

fs.writeFileSync(canalsPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
console.log(`Marked ${fcbCount} channels as FCB. ${canals.length - fcbCount} remain in "Altres".`);
