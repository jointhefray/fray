// Integration test for the full collector pipeline (protocol.md §6):
// an in-test issuer keypair + a stub JWKS HTTP server + a real Redis.
//
// Requires Redis on localhost:6379 (e.g. `docker run --rm -p 6379:6379
// redis:7-alpine`). If none is reachable the suite SKIPS with a clear message
// rather than failing — the pipeline is exercised end-to-end or not at all.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { createClient } from 'redis';

import { configFromEnv } from '../src/config.js';
import { epochIdFor, lookupReportHash } from '../src/pipeline.js';
import { buildServer } from '../src/server.js';

const suite = RSABSSA.SHA384.PSS.Deterministic();

// ---- redis (skip everything, loudly, if unavailable) -----------------------

const redis = createClient({
  url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  socket: { connectTimeout: 1500, reconnectStrategy: false },
});
let redisAvailable = true;
try {
  await redis.connect();
  await redis.ping();
} catch {
  redisAvailable = false;
  if (process.env.REQUIRE_REDIS === '1')
    throw new Error(
      'Redis is required for this test run; set REDIS_URL to an isolated test instance.',
    );
  console.error(
    '\n*** SKIPPING collector integration tests: no Redis on localhost:6379.\n' +
      '*** Start one with: docker run --rm -p 6379:6379 redis:7-alpine\n',
  );
}
const skip = redisAvailable ? false : 'requires Redis on localhost:6379';

// ---- in-test issuer + stub JWKS server ------------------------------------

const ISSUER = 'issuer.partner.example';
const kid = epochIdFor();
let base; // collector base URL
let app;
let jwksServer;
let publicKey;
let privateKey;
let watchlistDirectory;
let collectorConfig;

if (redisAvailable) {
  ({ privateKey, publicKey } = await suite.generateKey({
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
  }));
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  const jwksDoc = {
    keys: [
      { kty: 'RSA', n: jwk.n, e: jwk.e, kid, use: 'sig', alg: 'RSABSSA-SHA384-PSS-Deterministic' },
    ],
  };
  jwksServer = createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(jwksDoc));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));

  const cfg = configFromEnv({
    ISSUERS: `${ISSUER}=http://127.0.0.1:${jwksServer.address().port}`,
    REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  });
  watchlistDirectory = mkdtempSync(join(tmpdir(), 'fray-collector-watchlist-'));
  const watchlist = JSON.parse(readFileSync(cfg.watchlistPath, 'utf8'));
  watchlist.expires = new Date(Date.now() + 86400000).toISOString();
  cfg.watchlistPath = join(watchlistDirectory, 'watchlist.json');
  writeFileSync(cfg.watchlistPath, JSON.stringify(watchlist));
  collectorConfig = cfg;

  app = await buildServer(cfg, redis);
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
}

test.after(async () => {
  if (app) await app.close();
  if (jwksServer) jwksServer.close();
  if (redisAvailable) await redis.quit();
  if (watchlistDirectory) rmSync(watchlistDirectory, { recursive: true, force: true });
});

// ---- helpers ---------------------------------------------------------------

/** Full client-side RFC 9474 flow against the in-test private key. */
async function mintToken() {
  const msg = suite.prepare(randomBytes(32));
  const { blindedMsg, inv } = await suite.blind(publicKey, msg);
  const blindSig = await suite.blindSign(privateKey, blindedMsg);
  const sig = await suite.finalize(publicKey, msg, blindSig, inv);
  return {
    issuer: ISSUER,
    kid,
    msg: Buffer.from(msg).toString('base64'),
    sig: Buffer.from(sig).toString('base64'),
  };
}

// Unique creative per test run so quorum counters from earlier runs (30d TTL
// in a shared local Redis) can't interfere.
const runId = randomBytes(6).toString('hex');
const hourNow = new Date().toISOString().slice(0, 13) + ':00:00Z';

// Illustrative Google click URL (envelope.md creative.click_url): opaque
// placeholders where the platform's ai/sig values would be, destination the
// example impersonator domain. Never a captured token.
const ACLK =
  'https://www.googleadservices.com/pagead/aclk?sa=L&ai=C0AAAAAAAAAAopaqueAAAAAAAAAAAA' +
  '&sig=AOD64_0AAAAAopaqueAAAAAAAAAAAA' +
  '&adurl=https%3A%2F%2Fwww.examplefashion-outlet.shop%2Fsale';

function makeEnvelope(token, overrides = {}) {
  return {
    v: 1,
    watchlist_version: 12, // matches watchlist.sample.json
    brand: 'example-fashion.com',
    platform: 'google.com',
    surface: 'search',
    observed_hour: hourNow,
    creative: {
      title: `Example Fashion Clearance ${runId} — 90% Off`,
      body: 'Final closing down sale. All stock must go today.',
      display_url: 'example-fashion.com/sale',
      click_url: ACLK,
    },
    token,
    ...overrides,
  };
}

function makeLookupEnvelope(token, overrides = {}) {
  return {
    ...makeEnvelope(token),
    v: 2,
    observed_domain: 'shop.example-fashion.com',
    creative: null,
    advertiser: { name: `Example Advertiser ${runId}`, country: 'United Kingdom' },
    lookup: {
      kind: 'google-batchexecute',
      batchCode: `original+batch/${runId}==`,
      atParameter: 'source_token-123%3a1788000000123',
    },
    ...overrides,
  };
}

async function submit(envelope, country = 'GB') {
  const res = await fetch(`${base}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ country, envelope }),
  });
  assert.equal(res.status, 200); // rejections are silent: 200 either way
  return res.json();
}

// ---- tests -----------------------------------------------------------------

test('healthz reports redis up', { skip }, async () => {
  const res = await fetch(`${base}/healthz`);
  assert.deepEqual(await res.json(), { ok: true, redis: 'up' });
});

test('valid envelope is accepted; replaying its token is token_reused', { skip }, async () => {
  const token = await mintToken();
  const envelope = makeEnvelope(token);

  assert.deepEqual(await submit(envelope), { accepted: true });

  // The accepted envelope was persisted under its token id with a TTL.
  const tokenId = createHash('sha256').update(Buffer.from(token.msg, 'base64')).digest('hex');
  const stored = await redis.get(`env:${tokenId}`);
  assert.ok(stored, 'accepted envelope persisted as env:<sha256(msg)>');
  // The client-sanitized creative.click_url survives validation and storage
  // unchanged; the collector does not reconstruct redacted search keywords.
  assert.equal(JSON.parse(stored).creative.click_url, ACLK);
  const ttl = await redis.ttl(`env:${tokenId}`);
  assert.ok(ttl > 0 && ttl <= 7776000, 'RAW_RETENTION TTL applied');

  // Same token again — even on a different creative — burns out.
  const replay = makeEnvelope(token);
  replay.creative.title = `something else entirely ${runId}`;
  assert.deepEqual(await submit(replay), { accepted: false, reason: 'token_reused' });
});

test('a tampered signature is rejected', { skip }, async () => {
  const token = await mintToken();
  const bad = Buffer.from(token.sig, 'base64');
  bad[0] ^= 0xff;
  token.sig = bad.toString('base64');
  assert.deepEqual(await submit(makeEnvelope(token)), { accepted: false, reason: 'bad_signature' });
});

test('a YouTube feed report is accepted with unknown country through OHTTP', { skip }, async () => {
  const envelope = makeEnvelope(await mintToken(), { platform: 'youtube.com', surface: 'feed' });
  assert.deepEqual(await submit(envelope, 'ZZ'), { accepted: true });
});

test('schema violations are rejected before anything else', { skip }, async () => {
  const token = await mintToken();
  // Fine-grained timestamp — the schema's observed_hour pattern kills it.
  const fineGrained = makeEnvelope(token, { observed_hour: '2026-08-29T14:37:22Z' });
  assert.deepEqual(await submit(fineGrained), { accepted: false, reason: 'schema' });
  // Smuggled extra field — additionalProperties: false.
  const smuggled = makeEnvelope(token);
  smuggled.user_id = 'u-123';
  assert.deepEqual(await submit(smuggled), { accepted: false, reason: 'schema' });
  // click_url is optional but constrained: https only, <= 2048 chars. The
  // exemption in envelope.md rule 2 is one field wide and still schema-checked.
  const plaintextClick = makeEnvelope(token);
  plaintextClick.creative.click_url = 'http://www.googleadservices.com/pagead/aclk?sa=L';
  assert.deepEqual(await submit(plaintextClick), { accepted: false, reason: 'schema' });
  const hugeClick = makeEnvelope(token);
  hugeClick.creative.click_url = `https://ads.example.com/aclk?x=${'y'.repeat(2048)}`;
  assert.deepEqual(await submit(hugeClick), { accepted: false, reason: 'schema' });
  // A sighting from a surface with no click URL is still a valid envelope
  // (fresh token: this one is accepted, so it burns).
  const noClick = makeEnvelope(await mintToken());
  delete noClick.creative.click_url;
  assert.deepEqual(await submit(noClick), { accepted: true });
  // The rejected token was NOT burned (schema check precedes the spent-set).
  assert.deepEqual(await submit(makeEnvelope(token)), { accepted: true });
});

test(
  'removed destination fields are rejected before token consumption in both versions',
  { skip },
  async () => {
    for (const makeReport of [makeEnvelope, makeLookupEnvelope]) {
      const report = makeReport(await mintToken(), {
        creative: { title: `Title-only report ${runId}` },
      });
      const oldShape = structuredClone(report);
      oldShape.creative.final_domain = 'destination.example';

      assert.deepEqual(await submit(oldShape, 'ZZ'), { accepted: false, reason: 'schema' });
      assert.deepEqual(await submit(report, 'ZZ'), { accepted: true });

      const tokenId = createHash('sha256')
        .update(Buffer.from(report.token.msg, 'base64'))
        .digest('hex');
      const stored = JSON.parse(await redis.get(`env:${tokenId}`));
      assert.deepEqual(stored.creative, report.creative);
    }
  },
);

test('unknown issuer and expired kid are rejected', { skip }, async () => {
  const token = await mintToken();
  const wrongIssuer = makeEnvelope({ ...token, issuer: 'unknown.example' });
  assert.deepEqual(await submit(wrongIssuer), { accepted: false, reason: 'unknown_issuer' });
  const oldKid = makeEnvelope({ ...token, kid: 'ep-2024-01' });
  assert.deepEqual(await submit(oldKid), { accepted: false, reason: 'token_expired' });
});

test(
  'v2 lookup-only reports verify real tokens and retain exact lookup data in storage',
  { skip },
  async () => {
    const token = await mintToken();
    const report = makeLookupEnvelope(token);
    assert.deepEqual(await submit(report, 'ZZ'), { accepted: true });

    const tokenId = createHash('sha256').update(Buffer.from(token.msg, 'base64')).digest('hex');
    const stored = JSON.parse(await redis.get(`env:${tokenId}`));
    assert.deepEqual(stored, report);
    assert.equal(stored.creative, null);
    assert.equal(stored.lookup.atParameter, 'source_token-123%3a1788000000123');
    const ttl = await redis.ttl(`env:${tokenId}`);
    assert.ok(ttl > 0 && ttl <= 7776000);
    assert.deepEqual(await submit(report, 'ZZ'), { accepted: false, reason: 'token_reused' });
  },
);

test(
  'v2 request values do not split the same advertiser into different review groups',
  { skip },
  async () => {
    const first = makeLookupEnvelope(await mintToken(), {
      advertiser: { name: `Grouping advertiser ${runId}`, country: 'GB' },
    });
    const hash = lookupReportHash(first);
    const day = first.observed_hour.slice(0, 10);
    const quorumKey = `q:${first.brand}|${hash}|ZZ|${day}`;

    for (let i = 0; i < 3; i++) {
      const report = {
        ...first,
        token: await mintToken(),
        lookup: {
          kind: 'google-batchexecute',
          batchCode: `different-batch-${i}`,
          atParameter: `different_token-123:178800000012${i}`,
        },
      };
      assert.deepEqual(await submit(report, 'ZZ'), { accepted: true });
    }
    assert.equal(await redis.get(quorumKey), '3');
    const candidates = (await redis.lRange('candidates', 0, -1)).map(JSON.parse);
    assert.equal(candidates.filter((candidate) => candidate.creative_hash === hash).length, 1);
  },
);

test(
  'v2 allows a displayed primary brand domain and rejects smuggled fields before burning a token',
  { skip },
  async () => {
    const token = await mintToken();
    const report = makeLookupEnvelope(token, {
      observed_domain: 'example-fashion.com',
      creative: { title: 'Ad for the real shop' },
      advertiser: { id: 'AR1234567890', name: 'Example Merchant Ltd' },
    });
    for (const field of ['adKey', 'atParameterEncoded', 'raw']) {
      const bad = structuredClone(report);
      bad.lookup[field] = 'must-not-be-stored';
      assert.deepEqual(await submit(bad, 'ZZ'), { accepted: false, reason: 'schema' });
    }
    const impossibleHour = { ...report, observed_hour: '2026-02-31T14:00:00Z' };
    assert.deepEqual(await submit(impossibleHour, 'ZZ'), { accepted: false, reason: 'schema' });
    assert.deepEqual(await submit(report, 'ZZ'), { accepted: true });

    const unmatched = makeLookupEnvelope(await mintToken(), {
      observed_domain: 'examplefashion.co.uk',
    });
    assert.deepEqual(await submit(unmatched, 'ZZ'), {
      accepted: false,
      reason: 'unmatched_domain',
    });
  },
);

test('v2 whole-envelope size rejection happens before token consumption', { skip }, async () => {
  const token = await mintToken();
  const report = makeLookupEnvelope(token);
  const oversized = structuredClone(report);
  oversized.lookup.batchCode = 'x';
  const bytes = Buffer.byteLength(JSON.stringify(oversized));
  oversized.lookup.batchCode = 'x'.repeat(8065 - bytes + 1);
  assert.equal(Buffer.byteLength(JSON.stringify(oversized)), 8065);
  assert.deepEqual(await submit(oversized, 'ZZ'), { accepted: false, reason: 'too_large' });
  assert.deepEqual(await submit(report, 'ZZ'), { accepted: true });
});

test(
  'expired local watchlist stops v2 acceptance without changing legacy v1 handling',
  { skip },
  async () => {
    const expired = JSON.parse(readFileSync(collectorConfig.watchlistPath, 'utf8'));
    expired.expires = '2000-01-01T00:00:00Z';
    const path = join(watchlistDirectory, 'expired.json');
    writeFileSync(path, JSON.stringify(expired));
    const expiredApp = await buildServer({ ...collectorConfig, watchlistPath: path }, redis);

    try {
      const report = makeLookupEnvelope(await mintToken());
      const result = await expiredApp.inject({
        method: 'POST',
        url: '/v1/events',
        payload: { country: 'ZZ', envelope: report },
      });
      assert.deepEqual(result.json(), { accepted: false, reason: 'stale_watchlist' });
      const tokenId = createHash('sha256')
        .update(Buffer.from(report.token.msg, 'base64'))
        .digest('hex');
      assert.equal(await redis.get(`env:${tokenId}`), null);

      const legacy = await expiredApp.inject({
        method: 'POST',
        url: '/v1/events',
        payload: { country: 'ZZ', envelope: makeEnvelope(await mintToken()) },
      });
      assert.deepEqual(legacy.json(), { accepted: true });
    } finally {
      await expiredApp.close();
    }
  },
);

test('first sighting of a new creative pushes exactly one triage item', { skip }, async () => {
  // Triage from sighting ONE (protocol.md §6 step 7, §6.1): envelopes are
  // safe for human eyes by construction, so analysts see candidates for
  // review before any quorum.
  const title = `Example Fashion First Sight ${runId}`;
  const expectedHash = createHash('sha256')
    .update(title.normalize('NFC').toLowerCase())
    .digest('hex');
  const before = (await redis.lRange('triage', 0, -1)).length;

  const first = makeEnvelope(await mintToken());
  first.creative.title = title;
  assert.deepEqual(await submit(first), { accepted: true });

  const afterFirst = (await redis.lRange('triage', 0, -1)).map((t) => JSON.parse(t));
  assert.equal(afterFirst.length, before + 1, 'exactly one new triage item');
  const item = afterFirst.find((t) => t.creative_hash === expectedHash);
  assert.ok(item, 'the triage item is for this creative');
  assert.equal(item.brand, 'example-fashion.com');
  assert.equal(item.country, 'GB');
  assert.equal(item.day, hourNow.slice(0, 10));
  assert.equal(item.watchlist_version, 12);

  // A second sighting of the same creative pushes nothing new: the
  // seen:<brand>|<creative_hash> NX flag dedupes for its 30-day TTL.
  const second = makeEnvelope(await mintToken());
  second.creative.title = title;
  assert.deepEqual(await submit(second), { accepted: true });
  assert.equal((await redis.lRange('triage', 0, -1)).length, before + 1, 'no second triage item');
});

test(
  'third distinct sighting of the same creative enqueues exactly one candidate',
  { skip },
  async () => {
    // A fresh creative for this test so the accepted envelope from the earlier
    // tests doesn't pre-load the quorum counter.
    const title = `Example Fashion Mega Sale ${runId}`;
    const before = (await redis.lRange('candidates', 0, -1)).length;

    for (let i = 1; i <= 3; i++) {
      const envelope = makeEnvelope(await mintToken());
      envelope.creative.title = title;
      assert.deepEqual(await submit(envelope), { accepted: true }, `sighting ${i} accepted`);
    }
    // One more past K must not enqueue a second candidate (NX flag key).
    const fourth = makeEnvelope(await mintToken());
    fourth.creative.title = title;
    assert.deepEqual(await submit(fourth), { accepted: true });

    const after = await redis.lRange('candidates', 0, -1);
    const ours = after
      .map((c) => JSON.parse(c))
      .filter((c) => {
        const expected = createHash('sha256')
          .update(title.normalize('NFC').toLowerCase())
          .digest('hex');
        return c.creative_hash === expected;
      });
    assert.equal(after.length, before + 1, 'exactly one new candidate');
    assert.equal(ours.length, 1);
    assert.equal(ours[0].brand, 'example-fashion.com');
    assert.equal(ours[0].country, 'GB');
    assert.equal(ours[0].reached_k, 3);
  },
);
