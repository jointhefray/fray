// Local end-to-end demo: blind issuance → encrypted OHTTP relay → gateway → collector.
// Fictional ad data and explicit demo authentication only.
import assert from 'node:assert/strict';
import { FrayOhttpClient } from '../ohttp/typescript/dist/client.js';
import { createHash, randomBytes } from 'node:crypto';
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { createClient } from 'redis';

const ISSUER_URL = process.env.ISSUER_URL ?? 'http://localhost:8081';
const RELAY_URL = process.env.RELAY_URL ?? 'http://localhost:8083';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const AUTH = process.env.PARTNER_AUTH ?? 'Bearer local-fray-demo-only';
const ISSUER_NAME = 'issuer.partner.example';

const suite = RSABSSA.SHA384.PSS.Deterministic();
const b64 = (u8) => Buffer.from(u8).toString('base64');

console.log(`issuer: ${ISSUER_URL}`);
console.log(`relay:  ${RELAY_URL}\n`);

// ── 1. Fetch the issuer's epoch key ─────────────────────────────────────────
async function waitFor(url) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Service did not become ready: ${url}`);
}
const jwksRes = await waitFor(`${ISSUER_URL}/.well-known/jwks.json`);
const keysResponse = await waitFor(`${RELAY_URL}/ohttp-keys`);
// Local demo only. Production must authenticate/pin this configuration.
const ohttp = FrayOhttpClient.create(new Uint8Array(await keysResponse.arrayBuffer()));
if (!jwksRes.ok) throw new Error(`jwks: ${jwksRes.status} — is the compose stack up?`);
const jwks = await jwksRes.json();
const jwk = jwks.keys.sort((a, b) => (a.kid < b.kid ? 1 : -1))[0];
console.log(`[issuer] current epoch key: kid=${jwk.kid} alg=${jwk.alg}`);
const publicKey = await crypto.subtle.importKey(
  'jwk',
  { kty: jwk.kty, n: jwk.n, e: jwk.e },
  { name: 'RSA-PSS', hash: 'SHA-384' },
  true,
  ['verify'],
);

// ── 2. Draw 3 tokens (blind → /issue → finalize) ────────────────────────────
const msgs = [];
const invs = [];
const blinded = [];
for (let i = 0; i < 3; i++) {
  const msg = suite.prepare(randomBytes(32));
  const { blindedMsg, inv } = await suite.blind(publicKey, msg);
  msgs.push(msg);
  invs.push(inv);
  blinded.push(b64(blindedMsg));
}
const issueRes = await fetch(`${ISSUER_URL}/issue`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: AUTH },
  body: JSON.stringify({ blinded }),
});
if (!issueRes.ok) throw new Error(`/issue: ${issueRes.status}`);
const { kid, signatures } = await issueRes.json();
const tokens = [];
for (let i = 0; i < msgs.length; i++) {
  const sig = await suite.finalize(
    publicKey,
    msgs[i],
    Buffer.from(signatures[i], 'base64'),
    invs[i],
  );
  tokens.push({ issuer: ISSUER_NAME, kid, msg: b64(msgs[i]), sig: b64(sig) });
}
console.log(`[client] drew ${tokens.length} tokens under ${kid} — issuer never saw their values\n`);

// ── 3. Build the sighting and submit it through the relay, 3 tokens ─────────
// Brand and creative match examples/collector/watchlist.sample.json.
const runId = randomBytes(3).toString('hex'); // fresh creative per run
const observedHour = new Date().toISOString().slice(0, 13) + ':00:00Z';
const creative = {
  title: `Example Fashion Clearance — 90% Off Everything [${runId}]`,
  body: 'Final closing down sale. All stock must go today.',
  display_url: 'example-fashion.com/sale',
  // Fictional click URL with opaque placeholders, never captured platform values.
  // A reporting client must redact matching search keywords while retaining
  // unrelated URL evidence, as specified in envelope.md sanitization rule 2.
  // No search query is present in this fixed demonstration. Other URL fields
  // still lose their query strings and fragments.
  click_url:
    'https://www.googleadservices.com/pagead/aclk?sa=L&ai=C0AAAAAAAAAAopaqueAAAAAAAAAAAA' +
    '&sig=AOD64_0AAAAAopaqueAAAAAAAAAAAA' +
    '&adurl=https%3A%2F%2Fwww.examplefashion-outlet.shop%2Fsale',
};

for (const [i, token] of tokens.entries()) {
  const envelope = {
    v: 1,
    watchlist_version: 12,
    brand: 'example-fashion.com',
    platform: 'google.com',
    surface: 'search',
    observed_hour: observedHour,
    creative,
    token,
  };
  const res = await ohttp.send(envelope, { relayUrl: `${RELAY_URL}/ohttp`, allowHttp: true });
  assert.equal(res.status, 200, 'gateway returned encrypted success');
  console.log(`[client → OHTTP relay → gateway] report ${i + 1}/3: ${res.status}`);
}
console.log('(country is ZZ: this encrypted transport does not derive client geography)');

// ── 4. Show what landed: triage from sighting 1, candidate at K=3 ───────────
const redis = await createClient({ url: REDIS_URL }).connect();
const triage = (await redis.lRange('triage', 0, -1)).map((t) => JSON.parse(t));
const candidates = (await redis.lRange('candidates', 0, -1)).map((c) => JSON.parse(c));
await redis.quit();

// The first sighting queued this creative for analyst triage (protocol.md §6.1).
// K prioritizes review; it does not gate the first report. lPush prepends,
// so index 0 is the newest.
const creativeHash = createHash('sha256')
  .update(creative.title.normalize('NFC').toLowerCase())
  .digest('hex');
const triageMatch = triage.find((t) => t.creative_hash === creativeHash);
const candidateMatch = candidates.find((c) => c.creative_hash === creativeHash);
assert.ok(triageMatch, 'the first report entered analyst triage');
assert.ok(candidateMatch, 'three distinct valid tokens produced a candidate');
assert.equal(candidateMatch.country, 'ZZ');
console.log('[collector] first-report triage and three-token candidate verified.');
console.log('Complete: real blind signatures and an encrypted request/response round trip.');
