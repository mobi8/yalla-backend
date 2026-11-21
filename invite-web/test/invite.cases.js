import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { invitePage } from '../api/invite.js';

const origin = 'https://backend.example';
test('resolves and escapes the inviter, presents a copyable code and allows a configured Apple listing', async () => {
  const {status,html} = await invitePage('yal-abc-def',{FRIENDS_API_ORIGIN:origin,APP_STORE_URL:'https://apps.apple.com/ae/app/id1234'},
    async url => {
      assert.equal(url.href, origin+'/invites/YAL-ABC-DEF');
      return Response.json({code:'YAL-ABC-DEF',nickname:'<img onerror="x">'});
    });
  assert.equal(status,200);
  assert.match(html,/&lt;img onerror=&quot;x&quot;&gt; invited you/);
  assert.match(html,/id="friend-code">YAL-ABC-DEF/);
  assert.match(html,/href="https:\/\/apps\.apple\.com\/ae\/app\/id1234"/);
});

test('rejects invalid and unknown codes, and keeps a valid code usable during backend downtime', async () => {
  assert.equal((await invitePage('<bad>',{})).status,404);
  assert.equal((await invitePage('YAL-ABC-DEF',{FRIENDS_API_ORIGIN:origin},async () => new Response('',{status:404}))).status,404);
  const offline = await invitePage('YAL-ABC-DEF',{APP_STORE_URL:'https://other.example/id1234'});
  assert.equal(offline.status,503);
  assert.match(offline.html,/id="friend-code">YAL-ABC-DEF/);
  assert.doesNotMatch(offline.html,/other\.example/);
});

test('AASA is scoped to the iOS app and invite paths', async () => {
  const aasa = JSON.parse(await readFile(new URL('../public/.well-known/apple-app-site-association', import.meta.url)));
  assert.deepEqual(aasa.applinks.details,[{appIDs:['858X3V5QRJ.com.mobi8.yallaball'],components:[{'/':'/f/*'}]}]);
});
