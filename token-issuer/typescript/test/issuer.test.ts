import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { FastifyRequest } from 'fastify';
import {
  PrivacyTokenIssuer,
  DailyQuota,
  KeyUnavailableError,
  buildServer,
  generateEpochKeys,
  type IssuanceEvent,
  type PublishedJwk,
} from '../src/index.js';
import { KeyManager, epochJwksPath, epochKeyPath, writeEpochKey } from '../src/keys.js';
import { bigIntToBytes, TOKEN_META_VALUES } from '../src/rsabssa.js';
import { configFromEnv } from '../src/config.js';
import { parseKeygenArgs } from '../src/keygen.js';
import { TEST_KEYS, importPublicJwk, suite, testKeyObject, u8, writeTestEpoch } from './support.js';

const auth = { authorization: 'Bearer test-session' };
const other = { authorization: 'Bearer other-session' };
const ALG = 'RSABSSA-SHA384-PSS-Deterministic';

function tempDir(t: TestContext, prefix = 'fray-issuer-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** `limit: null` keeps the library's default quota. */
async function setup(t: TestContext, { limit = 8 as number | null } = {}) {
  const directory = tempDir(t);
  await writeTestEpoch(directory, 'ep-2026-01', 0);
  let now = new Date('2026-01-05T12:00:00Z');
  const events: IssuanceEvent[] = [];
  const metaCalls: string[] = [];
  const accountMeta = new Map<string, number>([
    ['user-a', 2],
    ['user-b', 0],
  ]);
  let validateCalls = 0;
  const issuer = new PrivacyTokenIssuer<FastifyRequest>({
    keysDir: directory,
    clock: () => now,
    ...(limit === null ? {} : { quota: new DailyQuota(limit) }),
    validateUser: async (request) => {
      validateCalls++;
      return request.headers.authorization === auth.authorization
        ? 'user-a'
        : request.headers.authorization === other.authorization
          ? 'user-b'
          : null;
    },
    metaFor: async (subject) => {
      metaCalls.push(subject);
      return accountMeta.get(subject)!;
    },
    onIssue: (event) => {
      events.push(event);
    },
  });
  const app = await buildServer(issuer);
  t.after(() => app.close());
  const jwksResponse = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
  assert.equal(jwksResponse.statusCode, 200);
  const jwks = jwksResponse.json<{ keys: PublishedJwk[] }>().keys;
  const publicKeys = await Promise.all(
    TOKEN_META_VALUES.map((meta) => importPublicJwk(jwks[meta])),
  );
  /** Blind fresh messages for the epoch key of one metadata value. */
  async function blind(count: number, meta: number) {
    return Promise.all(
      Array.from({ length: count }, async () => {
        const message = suite.prepare(randomBytes(32));
        const { blindedMsg, inv } = await suite.blind(publicKeys[meta], message);
        return { message, inv, blinded: Buffer.from(blindedMsg).toString('base64') };
      }),
    );
  }
  const post = (body: object, headers: Record<string, string> = auth) =>
    app.inject({ method: 'POST', url: '/issue', headers, payload: body });
  const getMeta = (headers: Record<string, string> = auth) =>
    app.inject({ method: 'GET', url: '/meta', headers });
  return {
    issuer,
    app,
    directory,
    events,
    metaCalls,
    validateCalls: () => validateCalls,
    jwks,
    publicKeys,
    blind,
    post,
    getMeta,
    setMeta: (subject: string, value: number) => accountMeta.set(subject, value),
    setTime: (value: string) => {
      now = new Date(value);
    },
  };
}

test('client flow: /meta, blind for key (epoch, meta), issue, finalize and verify', async (t) => {
  const { getMeta, blind, post, publicKeys, events } = await setup(t);
  const metaResponse = await getMeta();
  assert.equal(metaResponse.statusCode, 200);
  assert.equal(metaResponse.headers['cache-control'], 'no-store');
  assert.deepEqual(metaResponse.json(), { meta: 2 });

  const tokens = await blind(3, 2);
  const response = await post({ meta: 2, blinded: tokens.map((token) => token.blinded) });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  const body = response.json<{ kid: string; signatures: string[] }>();
  assert.equal(body.kid, 'ep-2026-01.2');
  assert.equal(body.signatures.length, tokens.length);
  for (const [index, token] of tokens.entries()) {
    const blindSignature = u8(Buffer.from(body.signatures[index], 'base64'));
    const signature = await suite.finalize(publicKeys[2], token.message, blindSignature, token.inv);
    assert.equal(await suite.verify(publicKeys[2], signature, token.message), true);
    assert.equal(await suite.verify(publicKeys[2], signature, u8(randomBytes(32))), false);
  }
  assert.deepEqual(events, [
    {
      ts: '2026-01-05T12:00:00.000Z',
      event: 'issue',
      client: 'user-a',
      count: 3,
      epoch: 'ep-2026-01',
    },
  ]);
});

test('a token signed with key 1 does not verify as meta 2 (or any other value)', async (t) => {
  const { blind, post, publicKeys, setMeta } = await setup(t);
  setMeta('user-a', 1);
  const [token] = await blind(1, 1);
  const response = await post({ meta: 1, blinded: [token.blinded] });
  assert.equal(response.json().kid, 'ep-2026-01.1');
  const blindSignature = u8(Buffer.from(response.json().signatures[0], 'base64'));
  const signature = await suite.finalize(publicKeys[1], token.message, blindSignature, token.inv);
  assert.equal(await suite.verify(publicKeys[1], signature, token.message), true);
  for (const otherMeta of [0, 2, 3]) {
    assert.equal(await suite.verify(publicKeys[otherMeta], signature, token.message), false);
  }
  await assert.rejects(suite.finalize(publicKeys[2], token.message, blindSignature, token.inv));
});

test('/meta uses the host authentication, calls metaFor with its subject and is no-store', async (t) => {
  const { getMeta, metaCalls } = await setup(t);
  for (const authorization of ['', 'Bearer wrong', 'Basic invalid']) {
    const response = await getMeta({ authorization });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json(), { error: 'unauthorized' });
  }
  assert.deepEqual(metaCalls, []);
  assert.deepEqual((await getMeta(auth)).json(), { meta: 2 });
  assert.deepEqual((await getMeta(other)).json(), { meta: 0 });
  assert.deepEqual(metaCalls, ['user-a', 'user-b']);
});

test('409 meta_mismatch on a stale or wrong value consumes no quota', async (t) => {
  const { blind, post, getMeta, setMeta, events } = await setup(t, { limit: 3 });
  const forTwo = (await blind(3, 2)).map((token) => token.blinded);
  for (const meta of [0, 1, 3, 0, 1, 3]) {
    const response = await post({ meta, blinded: forTwo });
    assert.equal(response.statusCode, 409);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json(), { error: 'meta_mismatch' });
  }
  // Any mismatch is a 409, even for a batch outside the claimed key's modulus.
  const largest = TEST_KEYS[0].reduce((max, key) => (key.n > max ? key.n : max), 0n);
  const outside = bigIntToBytes(largest - 1n, 256).toString('base64');
  for (const meta of [0, 1, 3].filter((value) => TEST_KEYS[0][value].n < largest)) {
    assert.deepEqual((await post({ meta, blinded: [outside] })).json(), { error: 'meta_mismatch' });
  }
  assert.deepEqual(events, []);

  // The account's value changes between /meta and /issue: the client refetches and retries.
  setMeta('user-a', 3);
  assert.equal((await post({ meta: 2, blinded: forTwo })).statusCode, 409);
  assert.deepEqual((await getMeta()).json(), { meta: 3 });
  const forThree = (await blind(3, 3)).map((token) => token.blinded);
  assert.equal((await post({ meta: 3, blinded: forThree })).statusCode, 200);
  assert.equal((await post({ meta: 3, blinded: forThree.slice(0, 1) })).statusCode, 429);
  assert.equal(events.length, 1);
});

test('the request meta must be an integer from 0 to 3; checked before any quota', async (t) => {
  const { blind, post, metaCalls } = await setup(t, { limit: 2 });
  const blinded = (await blind(2, 2)).map((token) => token.blinded);
  for (const meta of [undefined, -1, 4, 1.5, '2', null, true, [2], {}]) {
    const response = await post(meta === undefined ? { blinded } : { meta, blinded });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: 'bad_meta' });
  }
  assert.deepEqual(metaCalls, []);
  assert.equal((await post({ meta: 2, blinded })).statusCode, 200);
});

test('metaFor results outside 0..3 or exceptions fail closed without consuming quota', async (t) => {
  const directory = tempDir(t);
  await writeTestEpoch(directory, 'ep-2026-01', 0);
  let result: () => unknown = () => 1;
  const taken: number[] = [];
  const issuer = new PrivacyTokenIssuer<FastifyRequest>({
    keysDir: directory,
    clock: () => new Date('2026-01-05T12:00:00Z'),
    validateUser: () => 'subject',
    metaFor: async () => result() as number,
    quota: {
      take: (_subject, count) => {
        taken.push(count);
        return true;
      },
    },
    onIssue: () => {},
  });
  const app = await buildServer(issuer);
  t.after(() => app.close());
  const jwk = (await app.inject({ method: 'GET', url: '/.well-known/jwks.json' })).json().keys[1];
  const message = suite.prepare(randomBytes(32));
  const { blindedMsg } = await suite.blind(await importPublicJwk(jwk), message);
  const blinded = [Buffer.from(blindedMsg).toString('base64')];
  const failures: Array<() => unknown> = [
    () => 4,
    () => -1,
    () => 1.5,
    () => '1',
    () => null,
    () => undefined,
    () => true,
    () => NaN,
    () => {
      throw new Error('private metadata diagnostic');
    },
  ];
  for (const failure of failures) {
    result = failure;
    for (const response of [
      await app.inject({ method: 'GET', url: '/meta' }),
      await app.inject({ method: 'POST', url: '/issue', payload: { meta: 1, blinded } }),
    ]) {
      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.json(), { error: 'internal_error' });
    }
  }
  assert.deepEqual(taken, []);
  result = () => 1;
  assert.equal(
    (await app.inject({ method: 'POST', url: '/issue', payload: { meta: 1, blinded } })).statusCode,
    200,
  );
  assert.deepEqual(taken, [1]);
});

test('all batch and integer validation precedes quota consumption', async (t) => {
  const { blind, post, jwks } = await setup(t, { limit: 3 });
  const tokens = await blind(3, 2);
  const valid = tokens[0].blinded;
  const nonCanonical =
    Buffer.concat([Buffer.alloc(255), Buffer.from([1])])
      .toString('base64')
      .slice(0, -3) + 'R==';
  const cases: object[] = [
    {},
    { meta: 2 },
    { meta: 2, blinded: [] },
    { meta: 2, blinded: Array(17).fill(valid) },
    { meta: 2, blinded: [null] },
    { meta: 2, blinded: ['bad base64!!'] },
    { meta: 2, blinded: ['AAAA'] },
    { meta: 2, blinded: [Buffer.alloc(256).toString('base64')] },
    { meta: 2, blinded: [Buffer.from(jwks[2].n, 'base64url').toString('base64')] },
    { meta: 2, blinded: [nonCanonical] },
    { meta: 2, blinded: [valid, 'bad'] },
  ];
  for (const body of cases) assert.equal((await post(body)).statusCode, 400);
  const batch = tokens.map((token) => token.blinded);
  assert.equal((await post({ meta: 2, blinded: batch })).statusCode, 200);
  assert.equal((await post({ meta: 2, blinded: [valid] })).statusCode, 429);
});

test('defaults: one batch of 16 per subject per UTC day, then 429', async (t) => {
  const { blind, post } = await setup(t, { limit: null });
  const token = (await blind(1, 2))[0].blinded;
  const response = await post({ meta: 2, blinded: Array(16).fill(token) });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().signatures.length, 16);
  assert.equal((await post({ meta: 2, blinded: [token] })).statusCode, 429);
});

test('concurrent quota reservations are atomic, per subject and reset at UTC midnight', async (t) => {
  const { blind, post, setTime } = await setup(t, { limit: 3 });
  const forTwo = (await blind(1, 2))[0].blinded;
  const results = await Promise.all(
    Array.from({ length: 4 }, () => post({ meta: 2, blinded: [forTwo, forTwo] })),
  );
  assert.equal(results.filter((response) => response.statusCode === 200).length, 1);
  assert.equal(results.filter((response) => response.statusCode === 429).length, 3);
  assert.equal((await post({ meta: 2, blinded: [forTwo] })).statusCode, 200);
  assert.equal((await post({ meta: 2, blinded: [forTwo] })).statusCode, 429);
  const forZero = (await blind(1, 0))[0].blinded;
  assert.equal((await post({ meta: 0, blinded: [forZero] }, other)).statusCode, 200);
  setTime('2026-01-06T00:00:00Z');
  assert.equal((await post({ meta: 2, blinded: [forTwo] })).statusCode, 200);
});

test('JWKS: eight keys, public, unauthenticated and byte-identical for every requester', async (t) => {
  const { app, directory, validateCalls } = await setup(t);
  await writeTestEpoch(directory, 'ep-2025-12', 1);
  const before = validateCalls();
  const variants: Record<string, string>[] = [
    {},
    auth,
    other,
    { authorization: 'Bearer wrong' },
    { cookie: 'session=abc' },
  ];
  const responses = await Promise.all(
    variants.map((headers) =>
      app.inject({ method: 'GET', url: '/.well-known/jwks.json', headers }),
    ),
  );
  for (const response of responses) {
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload, responses[0].payload);
    assert.equal(response.headers['cache-control'], 'public, max-age=3600');
    assert.equal(response.headers.vary, undefined);
    assert.equal(response.headers['set-cookie'], undefined);
  }
  assert.equal(validateCalls(), before);
  const expected = [
    ...TOKEN_META_VALUES.map((meta) => ['ep-2026-01', 0, meta] as const),
    ...TOKEN_META_VALUES.map((meta) => ['ep-2025-12', 1, meta] as const),
  ].map(([epoch, set, meta]) => ({
    kty: 'RSA',
    n: bigIntToBytes(TEST_KEYS[set][meta].n, 256).toString('base64url'),
    e: 'AQAB',
    kid: `${epoch}.${meta}`,
    use: 'sig',
    alg: ALG,
  }));
  assert.deepEqual(responses[0].json(), { keys: expected });
  assert.equal(new Set(expected.map((key) => key.n)).size, 8);
});

test('rotation: previous epoch published; a missing current epoch is a 503, not new keys', async (t) => {
  const directory = tempDir(t);
  await writeTestEpoch(directory, 'ep-2025-12', 1);
  await writeTestEpoch(directory, 'ep-2026-01', 0);
  let now = new Date('2026-01-01T00:00:00Z');
  const issuer = new PrivacyTokenIssuer<string>({
    keysDir: directory,
    clock: () => now,
    validateUser: () => 'subject',
    metaFor: () => 0,
    onIssue: () => {},
  });
  await issuer.initialize();
  const published = await issuer.publishKeys();
  assert.deepEqual(
    published.keys.map((key) => key.kid),
    ['ep-2026-01.0', 'ep-2026-01.1', 'ep-2026-01.2', 'ep-2026-01.3'].concat([
      'ep-2025-12.0',
      'ep-2025-12.1',
      'ep-2025-12.2',
      'ep-2025-12.3',
    ]),
  );
  assert.deepEqual(await new KeyManager(directory).jwks(now), published);
  assert.equal(statSync(epochKeyPath(directory, 'ep-2026-01', 3)).mode & 0o777, 0o600);

  now = new Date('2026-02-01T00:00:00Z');
  assert.deepEqual(
    (await issuer.publishKeys()).keys.map((key) => key.kid),
    ['ep-2026-01.0', 'ep-2026-01.1', 'ep-2026-01.2', 'ep-2026-01.3'],
  );
  await assert.rejects(issuer.initialize(), KeyUnavailableError);
  await assert.rejects(issuer.issue('session', { meta: 0, blinded: ['AAAA'] }), {
    status: 503,
    code: 'key_unavailable',
  });
});

test('an epoch with three keys fails startup, and a partial previous epoch fails closed', async (t) => {
  const directory = tempDir(t);
  await writeTestEpoch(directory, 'ep-2026-01', 0, [0, 1, 3]);
  const options = {
    keysDir: directory,
    clock: () => new Date('2026-01-05T12:00:00Z'),
    validateUser: () => 'subject',
    metaFor: () => 0,
  };
  await assert.rejects(
    buildServer(new PrivacyTokenIssuer<FastifyRequest>(options)),
    /incomplete ep-2026-01/,
  );

  const later = tempDir(t);
  await writeTestEpoch(later, 'ep-2026-01', 0);
  await writeTestEpoch(later, 'ep-2025-12', 1, [0, 1, 2]);
  const issuer = new PrivacyTokenIssuer<string>({ ...options, keysDir: later });
  await issuer.initialize();
  await assert.rejects(issuer.publishKeys(), /incomplete ep-2025-12/);
});

test('keys from other schemes, wrong parameters or one key reused for two values are refused', async (t) => {
  const directory = tempDir(t);
  const pem = (key = testKeyObject(1, 0)) => key.export({ type: 'pkcs8', format: 'pem' });
  // Earlier file names (one key per epoch, or another suite) are ignored entirely.
  writeFileSync(join(directory, 'ep-2026-01.key.pem'), pem(), { mode: 0o600 });
  writeFileSync(join(directory, 'ep-2026-01.pbrsa.key.pem'), pem(), { mode: 0o600 });
  const when = new Date('2026-01-05T12:00:00Z');
  await assert.rejects(new KeyManager(directory).current(when), KeyUnavailableError);
  assert.deepEqual(await new KeyManager(directory).jwks(when), { keys: [] });

  const small = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey;
  const smallExponent = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 3,
  }).privateKey;
  for (const bad of [small, smallExponent]) {
    const keysDir = tempDir(t);
    await writeTestEpoch(keysDir, 'ep-2026-01', 0, [0, 1, 2]);
    writeFileSync(epochKeyPath(keysDir, 'ep-2026-01', 3), pem(bad), { mode: 0o600 });
    await assert.rejects(new KeyManager(keysDir).current(when), /RSA-2048 key with e = 65537/);
  }

  const reused = tempDir(t);
  await writeTestEpoch(reused, 'ep-2026-01', 0, [0, 1, 2]);
  await writeEpochKey(reused, 'ep-2026-01', 3, testKeyObject(0, 1));
  await assert.rejects(new KeyManager(reused).current(when), /reuses a key/);
});

test('corrupt key files fail closed instead of silently changing a public key', async (t) => {
  const directory = tempDir(t);
  await writeTestEpoch(directory, 'ep-2026-01', 0, [0, 1, 2]);
  const path = epochKeyPath(directory, 'ep-2026-01', 3);
  writeFileSync(path, 'corrupt key');
  await assert.rejects(new KeyManager(directory).jwks(new Date('2026-01-01Z')));
  assert.equal(readFileSync(path, 'utf8'), 'corrupt key');
});

test('key writes never replace an existing key, including concurrent writers', async (t) => {
  const directory = tempDir(t);
  const results = await Promise.all(
    [0, 1, 0, 1].map((set) => writeEpochKey(directory, 'ep-2026-01', 0, testKeyObject(set, 0))),
  );
  assert.equal(results.filter(Boolean).length, 1);
  const winner = readFileSync(epochKeyPath(directory, 'ep-2026-01', 0), 'utf8');
  assert.equal(await writeEpochKey(directory, 'ep-2026-01', 0, testKeyObject(1, 3)), false);
  assert.equal(readFileSync(epochKeyPath(directory, 'ep-2026-01', 0), 'utf8'), winner);
});

test('generateEpochKeys creates only missing keys, keeps existing ones and writes the JWKS', async (t) => {
  const directory = tempDir(t);
  await writeTestEpoch(directory, 'ep-2026-01', 0, [0, 2]);
  const kept = [0, 2].map((meta) => readFileSync(epochKeyPath(directory, 'ep-2026-01', meta as 0)));
  const generated = await generateEpochKeys(directory, 'ep-2026-01');
  assert.deepEqual(generated.created, ['ep-2026-01.1', 'ep-2026-01.3']);
  assert.deepEqual(
    [0, 2].map((meta) => readFileSync(epochKeyPath(directory, 'ep-2026-01', meta as 0))),
    kept,
  );
  const manager = new KeyManager(directory);
  const published = await manager.jwks(new Date('2026-01-05Z'));
  assert.equal(published.keys.length, 4);
  assert.equal(generated.jwksPath, epochJwksPath(directory, 'ep-2026-01'));
  assert.deepEqual(JSON.parse(readFileSync(generated.jwksPath, 'utf8')), published);
  assert.equal(statSync(generated.jwksPath).mode & 0o777, 0o644);
  for (const meta of TOKEN_META_VALUES) {
    assert.equal(statSync(epochKeyPath(directory, 'ep-2026-01', meta)).mode & 0o777, 0o600);
    const n = Buffer.from(published.keys[meta].n, 'base64url');
    assert.equal(
      generated.modulusSha256[`ep-2026-01.${meta}`],
      createHash('sha256').update(n).digest('hex'),
    );
  }

  const again = await generateEpochKeys(directory, 'ep-2026-01');
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.modulusSha256, generated.modulusSha256);
});

test('HTTP adapter hides auth failures and caps request bodies', async (t) => {
  const { issuer, app } = await setup(t);
  const huge = await app.inject({
    method: 'POST',
    url: '/issue',
    headers: auth,
    payload: { meta: 2, blinded: ['x'.repeat(70000)] },
  });
  assert.equal(huge.statusCode, 413);
  const invalidJson = await app.inject({
    method: 'POST',
    url: '/issue',
    headers: { ...auth, 'content-type': 'application/json' },
    payload: '{bad',
  });
  assert.equal(invalidJson.statusCode, 400);
  await assert.rejects(issuer.issue({ headers: {} } as FastifyRequest, {}), {
    code: 'unauthorized',
  });
  await assert.rejects(issuer.meta({ headers: {} } as FastifyRequest), { code: 'unauthorized' });
});

test('configuration rejects implicit demo credentials, nonconformant limits and bad demo meta', () => {
  const demo = { FRAY_LOCAL_DEMO: '1', LOCAL_DEMO_TOKEN: 'local-example-token' };
  assert.throws(() => configFromEnv({}));
  assert.throws(() => configFromEnv({ FRAY_LOCAL_DEMO: '1', LOCAL_DEMO_TOKEN: 'short' }));
  assert.throws(() => configFromEnv({ ...demo, NODE_ENV: 'production' }));
  assert.equal(configFromEnv(demo).host, '127.0.0.1');
  assert.equal(configFromEnv(demo).meta, 0);
  assert.equal(configFromEnv(demo).dailyQuota, 16);
  assert.equal(configFromEnv({ ...demo, LOCAL_DEMO_META: '3' }).meta, 3);
  for (const meta of ['4', '-1', '1.0', ' 1', 'x', '']) {
    assert.throws(() => configFromEnv({ ...demo, LOCAL_DEMO_META: meta }));
  }
  for (const quota of [0, -1, 17, NaN, 1.5]) assert.throws(() => new DailyQuota(quota));
  for (const maxBatch of [0, 17, 1.5]) {
    assert.throws(
      () =>
        new PrivacyTokenIssuer({
          keysDir: 'k',
          validateUser: () => 'x',
          metaFor: () => 0,
          maxBatch,
        }),
      /maxBatch/,
    );
  }
});

test('keygen arguments: keys dir, current/next/explicit epochs, and refusals', () => {
  const now = new Date('2026-12-15T00:00:00Z');
  assert.deepEqual(parseKeygenArgs(['--keys-dir', 'k'], {}, now), {
    keysDir: 'k',
    epochs: ['ep-2026-12'],
  });
  assert.deepEqual(parseKeygenArgs(['--epoch', 'next'], { KEYS_DIR: 'env' }, now), {
    keysDir: 'env',
    epochs: ['ep-2027-01'],
  });
  assert.deepEqual(
    parseKeygenArgs(
      ['--keys-dir', 'k', '--epoch', 'current', '--epoch', 'ep-2027-02', '--epoch', 'current'],
      {},
      now,
    ).epochs,
    ['ep-2026-12', 'ep-2027-02'],
  );
  for (const argv of [
    [],
    ['--epoch', 'ep-2026-13', '--keys-dir', 'k'],
    ['--epoch', 'ep-2026-12.1', '--keys-dir', 'k'],
    ['--keys-dir'],
    ['--force', 'k'],
  ]) {
    assert.throws(() => parseKeygenArgs(argv, {}, now));
  }
});

test('out-of-order reservations across midnight cannot refresh either allowance', () => {
  const quota = new DailyQuota(2);
  const before = new Date('2026-01-01T23:59:59Z');
  const after = new Date('2026-01-02T00:00:00Z');
  assert.equal(quota.take('user', 2, before), true);
  assert.equal(quota.take('user', 2, after), true);
  assert.equal(quota.take('user', 1, before), false);
  assert.equal(quota.take('user', 1, after), false);
});

test('async authentication, metadata and quota hooks preserve the subject and fail closed', async (t) => {
  const { directory, blind } = await setup(t);
  const calls: Array<[string, string, number?]> = [];
  const issuer = new PrivacyTokenIssuer<string>({
    keysDir: directory,
    validateUser: async (session) => (session === 'real-session' ? 'stable-subject' : null),
    metaFor: async (subject) => {
      calls.push(['meta', subject]);
      return 2;
    },
    quota: {
      take: async (subject, count) => {
        calls.push(['quota', subject, count]);
        return false;
      },
    },
    clock: () => new Date('2026-01-05T12:00:00Z'),
  });
  const token = (await blind(1, 2))[0].blinded;
  await assert.rejects(issuer.issue('bad-session', { meta: 2, blinded: [token] }), {
    code: 'unauthorized',
  });
  await assert.rejects(issuer.meta('bad-session'), { code: 'unauthorized' });
  assert.deepEqual(calls, []);
  assert.deepEqual(await issuer.meta('real-session'), { meta: 2 });
  await assert.rejects(issuer.issue('real-session', { meta: 2, blinded: [token] }), {
    code: 'quota_exceeded',
  });
  assert.deepEqual(calls, [
    ['meta', 'stable-subject'],
    ['meta', 'stable-subject'],
    ['quota', 'stable-subject', 1],
  ]);
});

test('both host callbacks are required; hook exceptions fail closed without diagnostics', async (t) => {
  const { directory } = await setup(t);
  assert.throws(
    () => new PrivacyTokenIssuer({ keysDir: directory, validateUser: () => 'x' } as never),
    /metaFor/,
  );
  assert.throws(
    () => new PrivacyTokenIssuer({ keysDir: directory, metaFor: () => 0 } as never),
    /validateUser/,
  );
  const issuer = new PrivacyTokenIssuer<FastifyRequest>({
    keysDir: directory,
    clock: () => new Date('2026-01-05T12:00:00Z'),
    validateUser: async () => {
      throw new Error('private authentication diagnostic');
    },
    metaFor: () => 0,
  });
  const app = await buildServer(issuer);
  t.after(() => app.close());
  for (const request of [
    { method: 'POST' as const, url: '/issue', payload: { meta: 0, blinded: ['AAAA'] } },
    { method: 'GET' as const, url: '/meta' },
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { error: 'internal_error' });
  }
});
