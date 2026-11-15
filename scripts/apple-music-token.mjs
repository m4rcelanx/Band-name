#!/usr/bin/env node
/* Erzeugt einen Apple-Music-Entwicklertoken (JWT, ES256) für MusicKit im Browser.
   Aufruf:  node scripts/apple-music-token.mjs AuthKey_ABC123.p8 ABC123 TEAMID [Tage]
   - AuthKey_….p8: privater MusicKit-Schlüssel aus dem Apple-Developer-Konto (niemals ins Repo!)
   - ABC123: Key ID, TEAMID: Team ID (beides im Apple-Developer-Konto)
   Der Token gilt höchstens 180 Tage und nur auf der Seite https://m4rcelanx.github.io. */
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [keyPath, keyId, teamId, daysArg] = process.argv.slice(2);
if(!keyPath || !keyId || !teamId){
  console.error('Aufruf: node scripts/apple-music-token.mjs AuthKey_KEYID.p8 KEYID TEAMID [Tage, max. 180]');
  process.exit(1);
}
const days = Math.min(180, Math.max(1, parseInt(daysArg || '180', 10) || 180));
const now = Math.floor(Date.now() / 1000);
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const head = b64({ alg:'ES256', kid:keyId });
const body = b64({ iss:teamId, iat:now, exp:now + days * 86400, origin:['https://m4rcelanx.github.io'] });
const key = createPrivateKey(readFileSync(keyPath));
const sig = sign('sha256', Buffer.from(head + '.' + body), { key, dsaEncoding:'ieee-p1363' }).toString('base64url');
console.log(head + '.' + body + '.' + sig);
console.error(`Gültig bis ${new Date((now + days * 86400) * 1000).toLocaleDateString('de-DE')}. In der App unter Einstellungen > Apple-Music-Entwicklertoken einfügen.`);
