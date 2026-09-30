import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { FastifyRequest } from 'fastify';
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { PrivacyTokenIssuer, DailyQuota, buildServer, type IssuanceEvent } from '../src/index.js';
import { KeyManager } from '../src/keys.js';
import { configFromEnv } from '../src/config.js';

const suite = RSABSSA.SHA384.PSS.Deterministic();
const auth = { authorization: 'Bearer test-session' };

async function setup(t: TestContext, limit = 8) {
  const directory = mkdtempSync(join(tmpdir(), 'fray-issuer-'));
  let now = new Date('2026-01-05T12:00:00Z');
  const events: IssuanceEvent[] = [];
  const issuer = new PrivacyTokenIssuer<FastifyRequest>({
    keysDir: directory,
    clock: () => now,
    quota: new DailyQuota(limit),
    validateUser: async (request) =>
      request.headers.authorization === auth.authorization
        ? 'user-a'
        : request.headers.authorization === 'Bearer other-session'
          ? 'user-b'
          : null,
    onIssue: (event) => {
      events.push(event);
    },
  });
  const app = await buildServer(issuer);
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const jwksResponse = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
  assert.equal(jwksResponse.statusCode, 200);
  const jwk = jwksResponse.json().keys[0];
  assert.equal(jwk.alg, 'RSABSSA-SHA384-PSS-Deterministic');
  assert.equal(jwk.use, 'sig');
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e },
    { name: 'RSA-PSS', hash: 'SHA-384' },
    true,
    ['verify'],
  );
  async function blind(count: number) {
    return Promise.all(
      Array.from({ length: count }, async () => {
        const message = suite.prepare(randomBytes(32));
        const { blindedMsg, inv } = await suite.blind(publicKey, message);
        return { message, inv, blinded: Buffer.from(blindedMsg).toString('base64') };
      }),
    );
  }
  const post = (body: object, headers = auth) =>
    app.inject({ method: 'POST', url: '/issue', headers, payload: body });
  return {
    issuer,
    app,
    directory,
    events,
    jwk,
    publicKey,
    blind,
    post,
    setTime: (value: string) => {
      now = new Date(value);
    },
  };
}

test('real RFC 9474 client: blind, issue, finalize and verify with published key', async (t) => {
  const { blind, post, publicKey, events } = await setup(t);
  const tokens = await blind(3);
  const response = await post({ blinded: tokens.map((token) => token.blinded) });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  const body = response.json<{ kid: string; signatures: string[] }>();
  assert.equal(body.kid, 'ep-2026-01');
  assert.equal(body.signatures.length, tokens.length);
  for (const [index, token] of tokens.entries()) {
    const signature = await suite.finalize(
      publicKey,
      token.message,
      Buffer.from(body.signatures[index], 'base64'),
      token.inv,
    );
    assert.equal(await suite.verify(publicKey, signature, token.message), true);
    assert.equal(await suite.verify(publicKey, signature, randomBytes(32)), false);
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

test('validateUser rejects missing or invalid sessions before issuance', async (t) => {
  const { post, events } = await setup(t);
  for (const authorization of ['', 'Bearer wrong', 'Basic invalid']) {
    const response = await post({ blinded: ['AAAA'] }, { authorization });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'unauthorized' });
  }
  assert.deepEqual(events, []);
});

test('all batch and integer validation precedes quota consumption', async (t) => {
  const { blind, post, jwk } = await setup(t, 3);
  const tokens = await blind(3);
  const valid = tokens[0].blinded;
  const nonCanonical =
    Buffer.concat([Buffer.alloc(255), Buffer.from([1])])
      .toString('base64')
      .slice(0, -3) + 'R==';
  const cases: object[] = [
    {},
    { blinded: [] },
    { blinded: Array(65).fill(valid) },
    { blinded: [null] },
    { blinded: ['bad base64!!'] },
    { blinded: ['AAAA'] },
    { blinded: [Buffer.alloc(256).toString('base64')] },
    { blinded: [Buffer.from(jwk.n, 'base64url').toString('base64')] },
    { blinded: [nonCanonical] },
    { blinded: [valid, 'bad'] },
  ];
  for (const body of cases) assert.equal((await post(body)).statusCode, 400);
  assert.equal((await post({ blinded: tokens.map((token) => token.blinded) })).statusCode, 200);
  assert.equal((await post({ blinded: [valid] })).statusCode, 429);
});

test('concurrent quota reservations are atomic, per subject and reset at UTC midnight', async (t) => {
  const { blind, post, setTime } = await setup(t, 3);
  const token = (await blind(1))[0].blinded;
  const results = await Promise.all(
    Array.from({ length: 4 }, () => post({ blinded: [token, token] })),
  );
  assert.equal(results.filter((response) => response.statusCode === 200).length, 1);
  assert.equal(results.filter((response) => response.statusCode === 429).length, 3);
  assert.equal((await post({ blinded: [token] })).statusCode, 200);
  assert.equal((await post({ blinded: [token] })).statusCode, 429);
  assert.equal(
    (await post({ blinded: [token] }, { authorization: 'Bearer other-session' })).statusCode,
    200,
  );
  setTime('2026-01-06T00:00:00Z');
  assert.equal((await post({ blinded: [token] })).statusCode, 200);
});

test('keys persist and JWKS rotates across year boundaries without publishing older keys', async (t) => {
  const { issuer, directory, setTime } = await setup(t);
  setTime('2025-11-30T23:59:59Z');
  await issuer.publishKeys();
  setTime('2025-12-31T23:59:59Z');
  await issuer.publishKeys();
  setTime('2026-01-01T00:00:00Z');
  const published = await issuer.publishKeys();
  assert.deepEqual(
    published.keys.map((key) => key.kid),
    ['ep-2026-01', 'ep-2025-12'],
  );
  const reopened = new KeyManager(directory);
  assert.deepEqual(await reopened.jwks(new Date('2026-01-01T00:00:00Z')), published);
  assert.equal(statSync(join(directory, 'ep-2026-01.key.pem')).mode & 0o777, 0o600);
});

test('independent concurrent key managers converge on one epoch key', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fray-key-race-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const results = await Promise.all(
    Array.from({ length: 4 }, () => new KeyManager(directory).jwks(new Date('2026-01-01Z'))),
  );
  assert(results.every((result) => result.keys[0].n === results[0].keys[0].n));
});

test('corrupt epoch files fail closed instead of silently changing the public key', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fray-corrupt-key-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'ep-2026-01.key.pem');
  writeFileSync(path, 'corrupt key');
  await assert.rejects(new KeyManager(directory).jwks(new Date('2026-01-01Z')));
  assert.equal(readFileSync(path, 'utf8'), 'corrupt key');
});

test('HTTP adapter hides auth failures and caps request bodies', async (t) => {
  const { issuer, app } = await setup(t);
  const huge = await app.inject({
    method: 'POST',
    url: '/issue',
    headers: auth,
    payload: { blinded: ['x'.repeat(70000)] },
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
});

test('configuration rejects implicit demo credentials and nonconformant quotas', () => {
  assert.throws(() => configFromEnv({}));
  assert.throws(() => configFromEnv({ FRAY_LOCAL_DEMO: '1', LOCAL_DEMO_TOKEN: 'short' }));
  assert.throws(() =>
    configFromEnv({
      FRAY_LOCAL_DEMO: '1',
      LOCAL_DEMO_TOKEN: 'local-example-token',
      NODE_ENV: 'production',
    }),
  );
  assert.equal(
    configFromEnv({ FRAY_LOCAL_DEMO: '1', LOCAL_DEMO_TOKEN: 'local-example-token' }).host,
    '127.0.0.1',
  );
  for (const quota of [0, -1, 65, NaN, 1.5]) assert.throws(() => new DailyQuota(quota));
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

test('async authentication and quota hooks preserve the subject and fail closed', async (t) => {
  const { directory, blind } = await setup(t);
  const calls: Array<[string, number]> = [];
  const issuer = new PrivacyTokenIssuer<string>({
    keysDir: directory,
    validateUser: async (session) => (session === 'real-session' ? 'stable-subject' : null),
    quota: {
      take: async (subject, count) => {
        calls.push([subject, count]);
        return false;
      },
    },
    clock: () => new Date('2026-01-05T12:00:00Z'),
  });
  const token = (await blind(1))[0].blinded;
  await assert.rejects(issuer.issue('bad-session', { blinded: [token] }), { code: 'unauthorized' });
  assert.deepEqual(calls, []);
  await assert.rejects(issuer.issue('real-session', { blinded: [token] }), {
    code: 'quota_exceeded',
  });
  assert.deepEqual(calls, [['stable-subject', 1]]);
});

test('auth hook exceptions fail closed without exposing internal diagnostics', async (t) => {
  const { directory } = await setup(t);
  const issuer = new PrivacyTokenIssuer<FastifyRequest>({
    keysDir: directory,
    validateUser: async () => {
      throw new Error('private authentication diagnostic');
    },
  });
  const app = await buildServer(issuer);
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/issue',
    payload: { blinded: ['AAAA'] },
  });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { error: 'internal_error' });
});
