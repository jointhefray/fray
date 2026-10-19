import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRelay } from '../src/relay.js';
import { MAX_MESSAGE_BYTES, MAX_RESPONSE_BYTES, REQUEST_TYPE, RESPONSE_TYPE } from '../src/http.js';
import { trustedCountryHeader } from '../src/metadata.js';
import { RELAY_SECRET, UA, vectors } from './helpers.js';

const gatewayUrl = 'https://gateway.example/ohttp';
const relayAuth = RELAY_SECRET;
const post = (body: BodyInit = new Uint8Array([1, 2, 3]), headers: HeadersInit = {}) =>
  new Request('https://relay.example/ohttp', {
    method: 'POST',
    headers: { 'content-type': REQUEST_TYPE, ...headers },
    body,
  });

/** Relay whose gateway records the forwarded headers and answers with ciphertext. */
function recordingRelay(options: Partial<Parameters<typeof createRelay>[0]> = {}) {
  const seen: Record<string, string>[] = [];
  const relay = createRelay({
    gatewayUrl,
    relayAuth,
    ...options,
    fetch: async (request) => {
      seen.push(Object.fromEntries(request.headers));
      return new Response(new Uint8Array([4]), { headers: { 'content-type': RESPONSE_TYPE } });
    },
  });
  return { relay, seen };
}

test('forwards opaque bytes only to the configured gateway, scrubbing identity in both directions', async () => {
  const relay = createRelay({
    gatewayUrl,
    relayAuth,
    country: trustedCountryHeader('CF-IPCountry'),
    fetch: async (request) => {
      assert.equal(request.url, gatewayUrl);
      assert.equal(request.redirect, 'manual');
      assert.equal(request.credentials, 'omit');
      assert.deepEqual(Object.fromEntries(request.headers), {
        accept: RESPONSE_TYPE,
        'content-type': REQUEST_TYPE,
        'fray-country': 'GB',
        'fray-device': 'macos-desktop',
        'fray-relay-auth': relayAuth,
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
      forwarded: 'for=192.0.2.1',
      'x-forwarded-for': '192.0.2.1',
      'cf-connecting-ip': '192.0.2.1',
      'cf-ipcountry': 'GB',
      'x-real-ip': '192.0.2.1',
      origin: 'https://site.example',
      referer: 'https://site.example/private',
      'user-agent': UA.mac,
      'sec-ch-ua': '"Chromium";v="126"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'accept-language': 'en-GB',
      traceparent: 'tracking',
      'x-request-id': 'client-correlator',
    }),
  );
  assert.equal(result.status, 200);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), new Uint8Array([4, 5, 6]));
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(result.headers.get('x-request-id'), null);
});

test('client-supplied Fray-* headers are never forwarded; the relay sets its own', async () => {
  const { relay, seen } = recordingRelay();
  const result = await relay(
    post(undefined, {
      'fray-country': 'US',
      'fray-device': 'ios-mobile',
      'fray-relay-auth': 'client-guess-'.padEnd(40, 'x'),
      'fray-anything': 'injected',
      'user-agent': UA.android,
    }),
  );
  assert.equal(result.status, 200);
  assert.deepEqual(seen, [
    {
      accept: RESPONSE_TYPE,
      'content-type': REQUEST_TYPE,
      'fray-country': 'ZZ',
      'fray-device': 'android-mobile',
      'fray-relay-auth': relayAuth,
    },
  ]);
});

test('without a trusted country source every request is ZZ, even with CF-IPCountry present', async () => {
  const { relay, seen } = recordingRelay();
  await relay(post(undefined, { 'cf-ipcountry': 'GB' }));
  assert.equal(seen[0]['fray-country'], 'ZZ');
});

test('platform country is normalized through the derivation table', async () => {
  for (const { input, expected } of vectors.country) {
    const { relay, seen } = recordingRelay({ country: () => input });
    assert.equal((await relay(post())).status, 200);
    assert.equal(seen[0]['fray-country'], expected, JSON.stringify(input));
  }
  const { relay, seen } = recordingRelay({ country: trustedCountryHeader('X-Geo-Country') });
  await relay(post(undefined, { 'x-geo-country': 'T1' }));
  await relay(post(undefined, { 'x-geo-country': 'de' }));
  assert.deepEqual(
    seen.map((headers) => headers['fray-country']),
    ['ZZ', 'DE'],
  );
});

test('device form is derived from client hints and user agent, which are not forwarded', async () => {
  for (const { name, platform, userAgent, expected } of vectors.device) {
    const headers: Record<string, string> = {};
    if (platform !== null) headers['sec-ch-ua-platform'] = platform;
    if (userAgent !== null) headers['user-agent'] = userAgent;
    const { relay, seen } = recordingRelay();
    assert.equal((await relay(post(undefined, headers))).status, 200);
    assert.equal(seen[0]['fray-device'], expected, name);
    assert.equal(seen[0]['user-agent'], undefined);
    assert.equal(seen[0]['sec-ch-ua-platform'], undefined);
  }
});

test('missing or malformed relay secret fails closed at construction without echoing it', () => {
  for (const value of [undefined, '', 'short', `${RELAY_SECRET}\nX-Injected: 1`]) {
    assert.throws(
      () => createRelay({ gatewayUrl, relayAuth: value }),
      (error: Error) =>
        /FRAY_RELAY_AUTH must be set/.test(error.message) &&
        (!value || !error.message.includes(value)),
    );
  }
});

test('rejects empty, oversized, wrong media type, compressed, and destination-query requests before forwarding', async () => {
  let calls = 0;
  const relay = createRelay({
    gatewayUrl,
    relayAuth,
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

test('accepts an encapsulated request of exactly 655360 bytes', async () => {
  let forwarded = 0;
  const relay = createRelay({
    gatewayUrl,
    relayAuth,
    fetch: async (request) => {
      forwarded = (await request.arrayBuffer()).byteLength;
      return new Response(new Uint8Array([1]), { headers: { 'content-type': RESPONSE_TYPE } });
    },
  });
  assert.equal(MAX_MESSAGE_BYTES, 655360);
  assert.equal((await relay(post(new Uint8Array(MAX_MESSAGE_BYTES)))).status, 200);
  assert.equal(forwarded, MAX_MESSAGE_BYTES);
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
  assert.equal((await createRelay({ gatewayUrl, relayAuth })(request)).status, 413);
});

test('scrubs gateway errors, rejects redirects, wrong response media, and oversized responses', async () => {
  for (const [upstream, expected] of [
    [new Response('private diagnostics', { status: 400 }), 400],
    [new Response('collector down', { status: 503 }), 503],
    [new Response(null, { status: 429 }), 429],
    [new Response(null, { status: 302, headers: { location: 'https://attacker.example' } }), 502],
    [new Response('plaintext', { headers: { 'content-type': 'application/json' } }), 502],
    [
      new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1), {
        headers: { 'content-type': RESPONSE_TYPE },
      }),
      502,
    ],
  ] as const) {
    const result = await createRelay({ gatewayUrl, relayAuth, fetch: async () => upstream })(
      post(),
    );
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
      relayAuth,
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

test('public key discovery uses a fixed route, strips incoming identity and sends no relay metadata', async () => {
  const relay = createRelay({
    gatewayUrl,
    relayAuth,
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
        new Request('https://relay.example/ohttp-keys', {
          headers: { cookie: 'identity', 'user-agent': UA.mac, 'fray-country': 'US' },
        }),
      )
    ).status,
    200,
  );
  assert.throws(() => createRelay({ gatewayUrl: 'http://gateway.example/ohttp', relayAuth }));
  assert.throws(() =>
    createRelay({ gatewayUrl, relayAuth, keysUrl: 'https://other.example/keys' }),
  );
});
