// Baut das Musiknetz für die Band-Kette aus Wikidata.
// Knoten: Künstler mit MusicBrainz-ID (P434).
// Kanten: Bandmitgliedschaft (P463 / P527) und gemeinsamer Song oder gemeinsames Album (P175).
// Ausgabe: graph.json im Repository-Hauptordner.
// Die App nutzt das Netz nur zum schnellen Finden; jeder Schritt wird danach in MusicBrainz belegt.

import { writeFileSync } from 'node:fs';

const UA = 'BandKette/1.0 (https://github.com/m4rcelanx/band-name)';
const HEX = '0123456789abcdef'.split('');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sparql(q, tries = 0){
  let r;
  try{
    r = await fetch('https://query.wikidata.org/sparql', {
      method:'POST',
      headers:{ 'User-Agent':UA, Accept:'application/sparql-results+json', 'Content-Type':'application/x-www-form-urlencoded' },
      body:new URLSearchParams({ query:q }),
      signal:AbortSignal.timeout(90000)
    });
  }catch(e){
    if(tries < 3){ await sleep(5000 * (tries + 1)); return sparql(q, tries + 1); }
    throw new Error('timeout');
  }
  if(r.status === 429 || r.status === 503){
    if(tries < 6){ const wait = (+r.headers.get('retry-after') || 10) * 1000; await sleep(wait); return sparql(q, tries + 1); }
  }
  let text;
  try{ text = await r.text(); }catch(e){ throw new Error('timeout'); }
  if([500, 502, 504].includes(r.status) || /TimeoutException|QueryTimeout/.test(text.slice(0, 3000))) throw new Error('timeout');
  if(!r.ok) throw new Error('HTTP ' + r.status + ' ' + text.slice(0, 200));
  try{ return JSON.parse(text).results.bindings; }catch(e){ throw new Error('timeout'); }
}

const idx = new Map(), ids = [], names = [];
function node(mb, label){
  let i = idx.get(mb);
  if(i === undefined){ i = ids.length; idx.set(mb, i); ids.push(mb); names.push(label || ''); }
  else if(!names[i] && label) names[i] = label;
  return i;
}
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function addEdges(rows, set){
  let n = 0;
  for(const b of rows){
    const a = b.a && b.a.value, c = b.b && b.b.value;
    if(!a || !c || a === c || !MBID.test(a) || !MBID.test(c)) continue;
    const i = node(a, b.xl && b.xl.value), j = node(c, b.yl && b.yl.value);
    const k = i < j ? i + ',' + j : j + ',' + i;
    if(!set.has(k)){ set.add(k); n++; }
  }
  return n;
}

// Fragt in Teilen ab (nach Anfang der MusicBrainz-ID); läuft ein Teil in eine Zeitüberschreitung, wird er weiter aufgeteilt.
async function partitioned(label, build, set, prefix = ''){
  const parts = prefix ? HEX.map(h => prefix + h) : HEX;
  for(const p of parts){
    try{
      const rows = await sparql(build(p));
      const n = addEdges(rows, set);
      console.log(`${label} ${p.padEnd(3)} ${rows.length} Zeilen, ${n} neue Kanten (gesamt ${set.size})`);
      await sleep(1500);
    }catch(e){
      if(e.message === 'timeout' && p.length < 4){ console.log(`${label} ${p}: zu groß, teile weiter auf`); await partitioned(label, build, set, p); }
      else { console.log(`${label} ${p}: übersprungen (${e.message})`); }
    }
  }
}

const LABELS = '';

const memberQ = p => `SELECT DISTINCT ?a ?b WHERE {
  ?x wdt:P434 ?a . FILTER(STRSTARTS(?a, "${p}"))
  { ?x wdt:P463 ?y } UNION { ?y wdt:P527 ?x }
  ?y wdt:P434 ?b .
  ${LABELS}
}`;

const songQ = p => `SELECT DISTINCT ?a ?b WHERE {
  ?x wdt:P434 ?a . FILTER(STRSTARTS(?a, "${p}"))
  ?s wdt:P175 ?x .
  ?s wdt:P175 ?y .
  FILTER(?x != ?y)
  VALUES ?t { wd:Q7366 wd:Q134556 wd:Q105543609 wd:Q2188189 wd:Q482994 }
  ?s wdt:P31 ?t .
  ?y wdt:P434 ?b .
  ${LABELS}
}`;

const t0 = Date.now();
const members = new Set(), songs = new Set();
await partitioned('Mitglieder', memberQ, members);
await partitioned('Songs', songQ, songs);

// Namen gesammelt nachladen (englisch, sonst deutsch, sonst sprachneutral)
for(let k = 0; k < ids.length; k += 300){
  const chunk = ids.slice(k, k + 300);
  try{
    const rows = await sparql(`SELECT ?a ?l (LANG(?l) AS ?lang) WHERE {
      VALUES ?a { ${chunk.map(x => `"${x}"`).join(' ')} }
      ?x wdt:P434 ?a . ?x rdfs:label ?l . FILTER(LANG(?l) IN ("en", "de", "mul"))
    }`);
    const rank = { en:0, de:1, mul:2 }, best = new Map();
    for(const b of rows){ const r = rank[b.lang.value] ?? 9, cur = best.get(b.a.value); if(!cur || r < cur.r) best.set(b.a.value, { r, l:b.l.value }); }
    for(const [a, v] of best){ const i = idx.get(a); if(i !== undefined) names[i] = v.l; }
  }catch(e){ console.log(`Namen ${k}: übersprungen (${e.message})`); }
  if(k % 6000 === 0) console.log(`Namen ${k} von ${ids.length}`);
  await sleep(700);
}

const flat = set => { const out = []; for(const k of set){ const [i, j] = k.split(','); out.push(+i, +j); } return out; };
const graph = { v:1, built:new Date().toISOString().slice(0, 10), ids, names, m:flat(members), s:flat(songs) };
const json = JSON.stringify(graph);
writeFileSync('graph.json', json);
console.log(`Fertig in ${Math.round((Date.now() - t0) / 1000)} s: ${ids.length} Künstler, ${members.size} Mitgliedschaften, ${songs.size} Song-Verbindungen, ${(json.length / 1048576).toFixed(1)} MB`);
if(ids.length < 1000) { console.error('Zu wenige Künstler, Netz wird nicht übernommen.'); process.exit(1); }
