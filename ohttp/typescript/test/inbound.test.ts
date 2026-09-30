import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KeyConfig, OHTTPClient } from 'ohttp-ts';
import { FrayOhttpClient } from '../src/client.js';
import { cipherSuite } from '../src/crypto.js';
import { createInbound, loadInboundKeys } from '../src/inbound.js';
import { INNER_TARGET, MAX_ENVELOPE_BYTES, MAX_MESSAGE_BYTES, REQUEST_TYPE } from '../src/http.js';
import { createRelay } from '../src/relay.js';

const suite = cipherSuite();
const key = await KeyConfig.generate(suite, 7, true);
const publicKeys = KeyConfig.serializeMultiple([key]);
const stored = {
  keyId: key.keyId,
  publicKey: Buffer.from(key.publicKey).toString('base64'),
  privateKey: Buffer.from(await suite.SerializePrivateKey(key.keyPair.privateKey)).toString(
    'base64',
  ),
};

test('inbound decrypts through a relay and returns generic encrypted success without outbound fetch', async () => {
  const originalFetch = globalThis.fetch;
  let outboundCalls = 0;
  globalThis.fetch = async () => {
    outboundCalls++;
    throw new Error('The inbound sink must never send a network request');
  };

  try {
    const inbound = createInbound({ keys: [key] });
    const relay = createRelay({ gatewayUrl: 'https://inbound.example/ohttp', fetch: inbound });
    const client = FrayOhttpClient.create(publicKeys);
    const report = {
      v: 2,
      creative: { title: 'discard-this-report' },
      token: { unverified: true },
    };

    // Tokens are intentionally not validated or burned at this temporary sink.
    // A repeated logical report receives the same generic result.
    for (let i = 0; i < 2; i++) {
      const result = await client.send(report, {
        relayUrl: 'https://relay.example/ohttp',
        fetch: relay,
      });
      assert.equal(result.status, 200);
      assert.equal(await result.text(), '');
    }
    assert.equal(outboundCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('inbound exposes only public configuration and liveness, not a plaintext report route', async () => {
  const inbound = createInbound({ keys: [key] });
  const keysResponse = await inbound(new Request('https://inbound.example/ohttp-keys'));
  assert.equal(keysResponse.status, 200);
  assert.equal(keysResponse.headers.get('content-type'), 'application/ohttp-keys');
  assert.deepEqual(new Uint8Array(await keysResponse.arrayBuffer()), publicKeys);
  const health = await inbound(new Request('https://inbound.example/healthz'));
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');
  assert.equal(
    (
      await inbound(
        new Request('https://inbound.example/v1/events', {
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'application/json' },
        }),
      )
    ).status,
    404,
  );
});

test('inbound rejects malformed, plaintext and oversized outer requests', async () => {
  const inbound = createInbound({ keys: [key] });
  for (const [body, contentType, expected] of [
    [new Uint8Array(), REQUEST_TYPE, 400],
    [new Uint8Array([1, 2, 3]), REQUEST_TYPE, 400],
    [new TextEncoder().encode('{}'), 'application/json', 415],
    [new Uint8Array(MAX_MESSAGE_BYTES + 1), REQUEST_TYPE, 413],
  ] as const) {
    const result = await inbound(
      new Request('https://inbound.example/ohttp', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body,
      }),
    );
    assert.equal(result.status, expected);
    assert.equal(await result.text(), '');
  }
});

test('inbound validates the decrypted operation and bounds the report before discarding', async () => {
  const inbound = createInbound({ keys: [key] });
  const client = new OHTTPClient(suite, key);
  for (const [inner, expected] of [
    [new Request('https://arbitrary.example/collect', { method: 'POST', body: '{}' }), 400],
    [new Request(INNER_TARGET), 400],
    [
      new Request(INNER_TARGET, {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json', cookie: 'identity' },
      }),
      400,
    ],
    [
      new Request(INNER_TARGET, {
        method: 'POST',
        body: '{',
        headers: { 'content-type': 'application/json' },
      }),
      400,
    ],
    [
      new Request(INNER_TARGET, {
        method: 'POST',
        body: '[]',
        headers: { 'content-type': 'application/json' },
      }),
      400,
    ],
    [
      new Request(INNER_TARGET, {
        method: 'POST',
        body: JSON.stringify({ text: 'x'.repeat(MAX_ENVELOPE_BYTES) }),
        headers: { 'content-type': 'application/json' },
      }),
      413,
    ],
  ] as const) {
    const { init, context } = await client.encapsulateRequest(inner);
    const outer = await inbound(new Request('https://inbound.example/ohttp', init));
    assert.equal(outer.status, 200);
    const result = await context.decapsulateResponse(outer);
    assert.equal(result.status, expected);
    assert.equal(await result.text(), '');
  }
});

test('inbound keys reload consistently from the persistent secret', async () => {
  const secret = JSON.stringify([stored]);
  const first = await loadInboundKeys(secret);
  const second = await loadInboundKeys(secret);
  assert.deepEqual(KeyConfig.serializeMultiple(first), publicKeys);
  assert.deepEqual(KeyConfig.serializeMultiple(second), publicKeys);

  const inbound = createInbound({ keys: second });
  const result = await FrayOhttpClient.create(KeyConfig.serializeMultiple(first)).send(
    { v: 2 },
    {
      relayUrl: 'https://inbound.example/ohttp',
      fetch: inbound,
    },
  );
  assert.equal(result.status, 200);
});

test('missing, invalid or duplicate private-key configuration fails closed without leaking it', async () => {
  await assert.rejects(loadInboundKeys(undefined), /OHTTP_KEYS_JSON is required/);
  for (const secret of [
    'do-not-log-this-secret',
    '{}',
    '[]',
    JSON.stringify([stored, stored]),
    JSON.stringify([{ ...stored, keyId: 256 }]),
    JSON.stringify([{ ...stored, privateKey: 'invalid-private-key' }]),
  ]) {
    await assert.rejects(loadInboundKeys(secret), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        'OHTTP_KEYS_JSON must contain valid gateway private keys with distinct IDs',
      );
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});
