import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRegistry,
  downloadSnapshot,
  MAX_SNAPSHOT_BYTES,
  parseSnapshot,
  refreshSnapshot,
  SNAPSHOT_KEY,
  UPSTREAM_URL,
  WATCHLIST_PATH,
  type Env,
} from '../src/index.js';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const URL = `https://registry.jointhefray.org${WATCHLIST_PATH}`;
const fixture = (overrides: Record<string, unknown> = {}) => ({
  v: 1,
  version: 42,
  published: '2026-09-30T11:00:00Z',
  expires: '2026-09-30T13:00:00Z',
  entries: [
    {
      domain: 'example.com',
      brand_terms: [],
      authorized_domains: ['example.com'],
      policy: 'closed',
      authorized_advertiser_ids: ['AR123456'],
    },
  ],
  ...overrides,
});
const encode = (value: unknown = fixture()) => JSON.stringify(value);
const json = (body: string, init: ResponseInit = {}) =>
  new Response(body, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });

function storage(initial: string | null = null) {
  let body = initial;
  const writes: string[] = [];
  const env: Env = {
    REGISTRY: {
      async get(key) {
        assert.equal(key, SNAPSHOT_KEY);
        return body;
      },
      async put(key, value) {
        assert.equal(key, SNAPSHOT_KEY);
        body = value;
        writes.push(value);
      },
    },
  };
  return { env, writes, value: () => body };
}

test('public reads use only KV, preserve document values, and expose no upstream headers', async () => {
  let outbound = 0;
  const worker = createRegistry({
    now: () => NOW,
    fetch: async () => {
      outbound++;
      throw new Error('Public reads must not fetch');
    },
  });
  const body = JSON.stringify(fixture(), null, 2);
  const { env } = storage(body);
  const result = await worker.fetch(
    new Request(URL, {
      headers: {
        authorization: 'Bearer private',
        cookie: 'id=private',
        'x-forwarded-for': '192.0.2.1',
      },
    }),
    env,
  );
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), fixture());
  assert.equal(result.headers.get('access-control-allow-origin'), '*');
  assert.equal(result.headers.get('cache-control'), 'public, max-age=300, must-revalidate');
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(result.headers.get('authorization'), null);
  assert.equal(outbound, 0);
});

test('missing, expired, invalid and unavailable KV fail closed without an upstream fallback', async () => {
  let outbound = 0;
  const worker = createRegistry({
    now: () => NOW,
    fetch: async () => {
      outbound++;
      throw new Error('No request-time fallback');
    },
  });
  for (const value of [
    null,
    encode(fixture({ expires: new Date(NOW).toISOString() })),
    '{',
    encode(fixture({ token: 'unexpected private data' })),
  ]) {
    const { env } = storage(value);
    const result = await worker.fetch(new Request(URL), env);
    assert.equal(result.status, 503);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await result.json(), { error: 'registry unavailable' });
  }
  const env: Env = {
    REGISTRY: {
      async get() {
        throw new Error('KV down');
      },
      async put() {
        throw new Error('Never write');
      },
    },
  };
  assert.equal((await worker.fetch(new Request(URL), env)).status, 503);
  assert.equal(outbound, 0);
});

test('cache lifetime never extends past source expiry and liveness does not require a snapshot', async () => {
  let now = NOW;
  const worker = createRegistry({ now: () => now });
  const { env } = storage(encode(fixture({ expires: new Date(NOW + 2500).toISOString() })));
  const first = await worker.fetch(new Request(URL), env);
  assert.equal(first.headers.get('cache-control'), 'public, max-age=2, must-revalidate');
  now += 2500;
  assert.equal((await worker.fetch(new Request(URL), env)).status, 503);
  const health = await worker.fetch(
    new Request('https://registry.jointhefray.org/healthz'),
    storage().env,
  );
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store');
});

test('HEAD, OPTIONS, unsupported methods and unknown paths are bounded read-only routes', async () => {
  let reads = 0;
  const env: Env = {
    REGISTRY: {
      async get() {
        reads++;
        return encode();
      },
      async put() {
        throw new Error('Never write');
      },
    },
  };
  const worker = createRegistry({ now: () => NOW });
  const head = await worker.fetch(new Request(URL, { method: 'HEAD' }), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(reads, 1);
  for (const [path, method, status] of [
    [URL, 'OPTIONS', 204],
    [URL, 'POST', 405],
    [`${URL}/unknown`, 'GET', 404],
  ] as const) {
    const result = await worker.fetch(new Request(path, { method }), env);
    assert.equal(result.status, status);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('access-control-allow-origin'), '*');
  }
  assert.equal(reads, 1);
});

test('scheduled refresh uses a fixed source and static request headers, then stores validated public JSON', async () => {
  const body = JSON.stringify(fixture(), null, 2);
  const { env, writes } = storage();
  const worker = createRegistry({
    now: () => NOW,
    fetch: async (url, init) => {
      assert.equal(url, UPSTREAM_URL);
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'manual');
      assert.deepEqual([...new Headers(init?.headers)], [['accept', 'application/json']]);
      assert.ok(init?.signal);
      return json(body, { headers: { 'set-cookie': 'discard=me' } });
    },
  });
  await worker.scheduled({}, env);
  assert.deepEqual(writes, [encode()]);
});

test('failed, redirected, stale and malformed refreshes preserve a valid stored snapshot unchanged', async () => {
  const original = encode();
  const { env, writes, value } = storage(original);
  const invalidEntry = fixture();
  invalidEntry.entries[0].authorized_advertiser_ids = ['not-an-advertiser-id'];
  const failures: (() => Promise<Response>)[] = [
    async () => {
      throw new Error('Network unavailable');
    },
    async () => json('{}', { status: 503 }),
    async () => json('{}', { status: 302, headers: { location: 'https://other.example/' } }),
    async () => new Response(original, { headers: { 'content-type': 'text/html' } }),
    async () => json('{bad source json'),
    async () => json(encode(fixture({ expires: new Date(NOW).toISOString() }))),
    async () => json(encode(fixture({ version: 41 }))),
    async () => json(encode(fixture({ token: 'never publish' }))),
    async () => json(encode(invalidEntry)),
  ];
  for (const fetcher of failures) {
    await assert.rejects(refreshSnapshot(env, { now: () => NOW, fetch: fetcher }));
    assert.equal(value(), original);
  }
  assert.deepEqual(writes, []);
});

test('body bounds apply to declared lengths and streamed bodies without Content-Length', async () => {
  for (const response of [
    json('{}', { headers: { 'content-length': String(MAX_SNAPSHOT_BYTES + 1) } }),
    json('{}', { headers: { 'content-length': 'invalid' } }),
    json('x'.repeat(MAX_SNAPSHOT_BYTES + 1)),
  ]) {
    await assert.rejects(
      downloadSnapshot({ now: () => NOW, fetch: async () => response }),
      /size limit/,
    );
  }
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_SNAPSHOT_BYTES));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    downloadSnapshot({
      now: () => NOW,
      fetch: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }),
    }),
    /size limit/,
  );
  assert.equal(cancelled, true);
});

test('invalid UTF-8 and nonpublic entry fields are rejected', async () => {
  await assert.rejects(
    downloadSnapshot({
      now: () => NOW,
      fetch: async () =>
        new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
    }),
  );
  assert.throws(() =>
    parseSnapshot(
      encode(
        fixture({
          entries: [
            {
              ...fixture().entries[0],
              account_id: 'never publish',
            },
          ],
        }),
      ),
    ),
  );
  assert.throws(() => parseSnapshot(encode(fixture({ published: 42 }))));
  assert.throws(() => parseSnapshot(encode(fixture({ published: undefined }))));
  assert.throws(() => parseSnapshot(encode(fixture({ published: '2026-09-30T13:00:00Z' }))));
  assert.throws(() => parseSnapshot(encode(fixture({ version: Number.MAX_SAFE_INTEGER + 1 }))));
});

test('duplicate JSON keys cannot publish overwritten, unvalidated private fields from source or seeded KV', async () => {
  const body = '{"entries":[{"private_user_id":"secret"}],' + encode().slice(1);
  const downloaded = await downloadSnapshot({ now: () => NOW, fetch: async () => json(body) });
  assert.deepEqual(JSON.parse(downloaded), fixture());
  assert.equal(downloaded.includes('secret'), false);
  const worker = createRegistry({ now: () => NOW });
  const result = await worker.fetch(new Request(URL), storage(body).env);
  assert.equal(result.status, 200);
  const publicBody = await result.text();
  assert.deepEqual(JSON.parse(publicBody), fixture());
  assert.equal(publicBody.includes('secret'), false);
});

test('valid refresh can repair a corrupt snapshot but cannot store a snapshot that expired during KV I/O', async () => {
  const repaired = storage('{');
  await refreshSnapshot(repaired.env, { now: () => NOW, fetch: async () => json(encode()) });
  assert.equal(repaired.value(), encode());
  let now = NOW;
  let written = false;
  const env: Env = {
    REGISTRY: {
      async get() {
        now += 3600_000;
        return null;
      },
      async put() {
        written = true;
      },
    },
  };
  await assert.rejects(
    refreshSnapshot(env, { now: () => now, fetch: async () => json(encode()) }),
    /expired/,
  );
  assert.equal(written, false);
});
