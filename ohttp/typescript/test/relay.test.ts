import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRelay } from '../src/relay.js';
import { MAX_MESSAGE_BYTES, REQUEST_TYPE, RESPONSE_TYPE } from '../src/http.js';

const gatewayUrl = 'https://gateway.example/ohttp';
const post = (body: BodyInit = new Uint8Array([1, 2, 3]), headers: HeadersInit = {}) =>
  new Request('https://relay.example/ohttp', {
    method: 'POST',
    headers: { 'content-type': REQUEST_TYPE, ...headers },
    body,
  });

test('forwards opaque bytes only to the configured gateway, scrubbing identity in both directions', async () => {
  const relay = createRelay({
    gatewayUrl,
    fetch: async (request) => {
      assert.equal(request.url, gatewayUrl);
      assert.equal(request.redirect, 'manual');
      assert.equal(request.credentials, 'omit');
      assert.deepEqual(Object.fromEntries(request.headers), {
        accept: RESPONSE_TYPE,
        'content-type': REQUEST_TYPE,
      });
      assert.deepEqual(new Uint8Array(await request.arrayBuffer()), new Uint8Array([1, 2, 3]));
      return new Response(new Uint8Array([4, 5, 6]), {
        headers: {
          'content-type': RESPONSE_TYPE,
          'set-cookie': 'id=tracking',
          'x-request-id': 'correlator',
        },
      });
    },
  });
  const result = await relay(
    post(undefined, {
      cookie: 'user=one',
      authorization: 'Bearer secret',
      'x-forwarded-for': '192.0.2.1',
      'cf-connecting-ip': '192.0.2.1',
      'x-real-ip': '192.0.2.1',
      origin: 'https://site.example',
      referer: 'https://site.example/private',
      'user-agent': 'browser',
      traceparent: 'tracking',
    }),
  );
  assert.equal(result.status, 200);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), new Uint8Array([4, 5, 6]));
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(result.headers.get('x-request-id'), null);
});

test('rejects empty, oversized, wrong media type, compressed, and destination-query requests before forwarding', async () => {
  let calls = 0;
  const relay = createRelay({
    gatewayUrl,
    fetch: async () => {
      calls++;
      throw new Error();
    },
  });
  assert.equal((await relay(post(''))).status, 400);
  assert.equal((await relay(post(new Uint8Array(MAX_MESSAGE_BYTES + 1)))).status, 413);
  assert.equal((await relay(post('{}', { 'content-type': 'application/json' }))).status, 415);
  assert.equal((await relay(post('abc', { 'content-encoding': 'gzip' }))).status, 415);
  assert.equal(
    (await relay(new Request('https://relay.example/ohttp?url=https://attacker.example'))).status,
    404,
  );
  assert.equal((await relay(new Request('https://relay.example/ohttp'))).status, 405);
  assert.equal(calls, 0);
});

test('streamed bodies are bounded even without Content-Length', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_MESSAGE_BYTES));
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  const request = new Request('https://relay.example/ohttp', {
    method: 'POST',
    headers: { 'content-type': REQUEST_TYPE },
    body,
    duplex: 'half',
  } as RequestInit);
  assert.equal((await createRelay({ gatewayUrl })(request)).status, 413);
});

test('scrubs gateway errors, rejects redirects, wrong response media, and oversized responses', async () => {
  for (const [upstream, expected] of [
    [new Response('private diagnostics', { status: 400 }), 400],
    [new Response(null, { status: 302, headers: { location: 'https://attacker.example' } }), 502],
    [new Response('plaintext', { headers: { 'content-type': 'application/json' } }), 502],
    [
      new Response(new Uint8Array(MAX_MESSAGE_BYTES + 1), {
        headers: { 'content-type': RESPONSE_TYPE },
      }),
      502,
    ],
  ] as const) {
    const result = await createRelay({ gatewayUrl, fetch: async () => upstream })(post());
    assert.equal(result.status, expected);
    assert.equal(await result.text(), '');
    assert.equal(result.headers.get('location'), null);
  }
});

test('fetch timeout fails closed', async () => {
  const keepAlive = setTimeout(() => {}, 100);
  try {
    const relay = createRelay({
      gatewayUrl,
      timeoutMs: 5,
      fetch: async (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    assert.equal((await relay(post())).status, 504);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('public key discovery uses a fixed route and strips incoming identity', async () => {
  const relay = createRelay({
    gatewayUrl,
    fetch: async (request) => {
      assert.equal(request.url, 'https://gateway.example/ohttp-keys');
      assert.deepEqual(Object.fromEntries(request.headers), { accept: 'application/ohttp-keys' });
      return new Response(new Uint8Array([0, 1]), {
        headers: { 'content-type': 'application/ohttp-keys' },
      });
    },
  });
  assert.equal(
    (
      await relay(
        new Request('https://relay.example/ohttp-keys', { headers: { cookie: 'identity' } }),
      )
    ).status,
    200,
  );
  assert.throws(() => createRelay({ gatewayUrl: 'http://gateway.example/ohttp' }));
  assert.throws(() => createRelay({ gatewayUrl, keysUrl: 'https://other.example/keys' }));
});
