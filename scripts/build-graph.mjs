// Baut das Musiknetz für die Band-Kette ausschließlich aus dem MusicBrainz-Datenexport.
// Damit enthält das Netz nur Verbindungen, die in MusicBrainz belegt sind:
//   - Bandbeziehungen aus l_artist_artist (Mitglied, Kollaboration, dieselbe Person)
//   - Feat-Verbindungen nur aus echten Aufnahmen (keine Videos, keine Remixe), deren Credit mehrere Künstler nennt
// Aufruf: node scripts/build-graph.mjs <Ordner mit mbdump-Tabellen> [Export-Name]
// Ausgabe: graph.json im aktuellen Ordner.

import { createReadStream, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const DIR = process.argv[2] || 'mbdump';
const DUMP = process.argv[3] || '';
const MAX_ARTISTS = +(process.env.MAX_ARTISTS || 150000);   // größte Künstler nach Anzahl Aufnahmen
const MAX_CREDIT = 12;                                       // Credits mit mehr Künstlern (Sammelsingles) auslassen

const LINK_GIDS = {
  '5be4c609-9afa-4ea0-910b-12ffb71e3821': 1, // member of band: entity0 ist Mitglied von entity1
  '75c09861-6857-4ec0-9729-84eefde7fc86': 3, // collaboration: entity0 gehört zu Projekt entity1
  'dd9886f2-1dfe-4270-97db-283f6839a666': 4, // is person: dieselbe Person
};
const LINK_NAMES = { 'member of band':1, 'collaboration':3, 'is person':4 };

// Remixe zählen nicht: erkannt am Titel, an der Beschreibung oder an einer Remixer-Beziehung
const REMIX_RE = /\b(re-?mix(es|ed)?|rmx|re-?work(ed)?|re-?edit|bootleg|mash-?up)\b/i;
const MIX_RE = /[\(\[][^\)\]]*\bmix(ed)?\b[^\)\]]*[\)\]]|\s[-–]\s.*\bmix\b/i;
const isRemix = (title, comment) => REMIX_RE.test(title) || (MIX_RE.test(title) && !/\boriginal mix\b/i.test(title)) || REMIX_RE.test(comment || '');

const t0 = Date.now();
const log = (...a) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, ...a);
const unesc = s => s.indexOf('\\') < 0 ? s : s.replace(/\\(.)/g, (_, c) => c === 't' ? '\t' : c === 'n' ? '\n' : c === 'r' ? '\r' : c);

async function each(table, fn){
  const file = join(DIR, table);
  if(!existsSync(file)) throw new Error('Tabelle fehlt: ' + file);
  const rl = createInterface({ input:createReadStream(file, { highWaterMark:1 << 20 }), crlfDelay:Infinity });
  let n = 0;
  for await (const line of rl){ fn(line.split('\t')); n++; }
  log(`${table}: ${n} Zeilen`);
  return n;
}

// 1. Beziehungstypen
const typeCode = new Map(), remixerTypes = new Set();
await each('link_type', c => {
  const code = LINK_GIDS[c[3]] || (c[4] === 'artist' && c[5] === 'artist' ? LINK_NAMES[c[6]] : 0);
  if(code) typeCode.set(+c[0], code);
  if(c[4] === 'artist' && c[5] === 'recording' && /remix/i.test(c[6])) remixerTypes.add(+c[0]);
});
log(`Remixer-Beziehungstypen: ${remixerTypes.size}`);
if(typeCode.size < 3) throw new Error('Beziehungstypen nicht gefunden: ' + [...typeCode.entries()].join(' '));

// 2. Konkrete Beziehungen (mit "beendet")
const linkCode = new Map(), remixerLinks = new Set();
await each('link', c => {
  const code = typeCode.get(+c[1]);
  if(code) linkCode.set(+c[0], code | (c[10] === 't' ? 8 : 0));
  if(remixerTypes.has(+c[1])) remixerLinks.add(+c[0]);
});

// Aufnahmen mit eingetragenem Remixer
const remixRec = new Set();
await each('l_artist_recording', c => { if(remixerLinks.has(+c[1])) remixRec.add(+c[3]); });
log(`${remixRec.size} Aufnahmen mit Remixer`);

// 3. Künstler
let maxId = 0;
const gid = [], name = [];
await each('artist', c => { const id = +c[0]; gid[id] = c[1]; name[id] = unesc(c[2]); if(id > maxId) maxId = id; });

// 4. Credits: welche Künstler stehen in welchem Credit
const creditFirst = new Map(), creditMulti = new Map();
await each('artist_credit_name', c => {
  const cr = +c[0], a = +c[2];
  if(!creditFirst.has(cr)){ creditFirst.set(cr, a); return; }
  const m = creditMulti.get(cr);
  if(m){ if(!m.includes(a)) m.push(a); }
  else if(creditFirst.get(cr) !== a) creditMulti.set(cr, [creditFirst.get(cr), a]);
});

// 5. Aufnahmen: Anzahl je Künstler und genutzte Mehrfach-Credits (nur echte Aufnahmen, keine Videos)
const recCount = new Uint32Array(maxId + 1);
const creditUse = new Map();
let remixSkipped = 0;
await each('recording', c => {
  if(c[8] === 't') return;
  if(remixRec.has(+c[0]) || isRemix(c[2], c[5])){ remixSkipped++; return; }
  const cr = +c[3];
  const m = creditMulti.get(cr);
  if(m){ for(const a of m) recCount[a]++; creditUse.set(cr, (creditUse.get(cr) || 0) + 1); }
  else { const a = creditFirst.get(cr); if(a !== undefined) recCount[a]++; }
});

log(`${remixSkipped} Remix-Aufnahmen ausgelassen`);

// 6. Auswahl: die Künstler mit den meisten Aufnahmen; jeder ausgewählte Künstler hat mindestens eine Aufnahme
const cand = [];
for(let i = 1; i <= maxId; i++) if(recCount[i] > 0 && gid[i]) cand.push(i);
cand.sort((x, y) => recCount[y] - recCount[x]);
const keep = new Uint8Array(maxId + 1);
cand.slice(0, MAX_ARTISTS).forEach(i => keep[i] = 1);
log(`${cand.length} Künstler mit Aufnahmen, ausgewählt ${Math.min(cand.length, MAX_ARTISTS)} (ab ${recCount[cand[Math.min(cand.length, MAX_ARTISTS) - 1]]} Aufnahmen)`);

// 7. Bandbeziehungen; Mitglieder mit eigener Aufnahme, die zwei ausgewählte Bands verbinden, kommen dazu
const rels = [];
await each('l_artist_artist', c => {
  const code = linkCode.get(+c[1]); if(!code) return;
  const a = +c[2], b = +c[3];
  if(a !== b && recCount[a] > 0 && recCount[b] > 0) rels.push([a, b, code]);
});
const bridgeHits = new Map();
for(const [a, b] of rels){
  if(keep[a] && !keep[b]) bridgeHits.set(b, (bridgeHits.get(b) || 0) + 1);
  if(keep[b] && !keep[a]) bridgeHits.set(a, (bridgeHits.get(a) || 0) + 1);
}
let bridges = 0;
for(const [x, n] of bridgeHits) if(n >= 2){ keep[x] = 1; bridges++; }
log(`${bridges} verbindende Bandmitglieder ergänzt`);

// 8. Knoten durchnummerieren
const idx = new Int32Array(maxId + 1).fill(-1);
const ids = [], names = [];
for(let i = 1; i <= maxId; i++) if(keep[i]){ idx[i] = ids.length; ids.push(gid[i]); names.push(name[i]); }

const m = [], seenM = new Set();
for(const [a, b, code] of rels){
  if(!keep[a] || !keep[b]) continue;
  const k = idx[a] * 4194304 + idx[b];
  if(seenM.has(k)) continue; seenM.add(k);
  m.push(idx[a], idx[b], code);
}

const s = [], seenS = new Set();
for(const [cr] of creditUse){
  const list = creditMulti.get(cr).filter(a => keep[a]);
  if(list.length < 2 || creditMulti.get(cr).length > MAX_CREDIT) continue;
  for(let x = 0; x < list.length; x++) for(let y = x + 1; y < list.length; y++){
    let p = idx[list[x]], q = idx[list[y]]; if(p > q){ const t = p; p = q; q = t; }
    const k = p * 4194304 + q;
    if(seenS.has(k)) continue; seenS.add(k);
    s.push(p, q);
  }
}

const graph = { v:2, src:'musicbrainz', dump:DUMP, built:new Date().toISOString().slice(0, 10), ids, names, m, s };
const json = JSON.stringify(graph);
writeFileSync('graph.json', json);
log(`Fertig: ${ids.length} Künstler, ${m.length / 3} Bandbeziehungen, ${s.length / 2} gemeinsame Aufnahmen, ${(json.length / 1048576).toFixed(1)} MB`);
if(ids.length < 1000 || m.length < 3000) { console.error('Zu wenige Daten, Netz wird nicht übernommen.'); process.exit(1); }
