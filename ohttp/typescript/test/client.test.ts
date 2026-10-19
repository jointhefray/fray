import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AEAD_AES_128_GCM, CipherSuite, KDF_HKDF_SHA256, KEM_DHKEM_X25519_HKDF_SHA256 } from 'hpke';
import { KeyConfig, OHTTPServer } from 'ohttp-ts';
import { FrayOhttpClient } from '../src/client.js';
import {
  INNER_TARGET,
  MAX_ENVELOPE_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_RESPONSE_BYTES,
  REQUEST_TYPE,
  RESPONSE_TYPE,
} from '../src/http.js';
import { createRelay } from '../src/relay.js';
import { RELAY_SECRET, envelopeOfSize, publicKeys, standInGateway } from './helpers.js';

const relayUrl = 'https://relay.example/ohttp';
const gatewayUrl = 'https://gateway.example/ohttp';

test('client encrypts reports through an opaque relay and decrypts the gateway response', async () => {
  const envelope = { evidence: 'not-visible-to-relay', token: 'one-use-token' };
  const ciphertexts: Uint8Array[] = [];
  const gateway = standInGateway(async (inner) => {
    assert.equal(inner.url, INNER_TARGET);
    assert.equal(inner.method, 'POST');
    assert.deepEqual(Object.fromEntries(inner.headers), { 'content-type': 'application/json' });
    assert.deepEqual(await inner.json(), envelope);
    return new Response(null, { status: 200 });
  });
  const relay = createRelay({
    gatewayUrl,
    relayAuth: RELAY_SECRET,
    fetch: async (request) => {
      ciphertexts.push(new Uint8Array(await request.clone().arrayBuffer()));
      return gateway(request);
    },
  });
  const client = FrayOhttpClient.create(publicKeys);
  for (let i = 0; i < 2; i++) {
    const result = await client.send(envelope, { relayUrl, fetch: relay });
    assert.equal(result.status, 200);
    assert.equal(await result.text(), '');
  }
  assert.equal(ciphertexts.length, 2);
  assert.notDeepEqual(ciphertexts[0], ciphertexts[1]);
  assert.equal(new TextDecoder().decode(ciphertexts[0]).includes(envelope.evidence), false);
});

test('client sends only ciphertext and its media type: no metadata, credentials or redirects', async () => {
  let outer: Request | undefined;
  const gateway = standInGateway();
  const client = FrayOhttpClient.create(publicKeys);
  const result = await client.send(
    { v: 3, kind: 'sighting' },
    {
      relayUrl,
      fetch: async (request) => {
        outer = request.clone();
        return gateway(request);
      },
    },
  );
  assert.equal(result.status, 200);
  assert.ok(outer);
  assert.equal(outer.method, 'POST');
  assert.equal(outer.url, relayUrl);
  assert.equal(outer.credentials, 'omit');
  assert.equal(outer.redirect, 'error');
  assert.equal(outer.referrerPolicy, 'no-referrer');
  assert.deepEqual(Object.fromEntries(outer.headers), { 'content-type': REQUEST_TYPE });
});

test('a 524288-byte envelope crosses every hop intact; one byte more never leaves the client', async () => {
  assert.equal(MAX_ENVELOPE_BYTES, 524288);
  const received: { envelope: unknown; metadata: Record<string, string | null> }[] = [];
  const encapsulated: number[] = [];
  const gateway = standInGateway(async (inner, outer) => {
    received.push({
      envelope: await inner.json(),
      metadata: {
        country: outer.headers.get('fray-country'),
        device: outer.headers.get('fray-device'),
        auth: outer.headers.get('fray-relay-auth'),
      },
    });
    return new Response(null, { status: 200 });
  });
  const relay = createRelay({
    gatewayUrl,
    relayAuth: RELAY_SECRET,
    fetch: async (request) => {
      encapsulated.push((await request.clone().arrayBuffer()).byteLength);
      return gateway(request);
    },
  });
  const client = FrayOhttpClient.create(publicKeys);

  const largest = envelopeOfSize(MAX_ENVELOPE_BYTES);
  const result = await client.send(largest, { relayUrl, fetch: relay });
  assert.equal(result.status, 200);
  assert.ok(encapsulated[0] > MAX_ENVELOPE_BYTES && encapsulated[0] <= MAX_MESSAGE_BYTES);
  assert.deepEqual(received, [
    { envelope: largest, metadata: { country: 'ZZ', device: 'other', auth: RELAY_SECRET } },
  ]);

  let calls = 0;
  await assert.rejects(
    client.send(envelopeOfSize(MAX_ENVELOPE_BYTES + 1), {
      relayUrl,
      fetch: async () => {
        calls++;
        return new Response();
      },
    }),
    /size limit/,
  );
  assert.equal(calls, 0);
});

test("the gateway's encrypted 503 reaches the caller as a retryable 503", async () => {
  const gateway = standInGateway(() => new Response(null, { status: 503 }));
  const relay = createRelay({ gatewayUrl, relayAuth: RELAY_SECRET, fetch: gateway });
  const result = await FrayOhttpClient.create(publicKeys).send(
    { v: 3, kind: 'sighting' },
    { relayUrl, fetch: relay },
  );
  assert.equal(result.status, 503);
  assert.equal(await result.text(), '');
});

test('a plain gateway refusal (403 without a valid relay secret) throws in the client', async () => {
  const relay = createRelay({
    gatewayUrl,
    relayAuth: RELAY_SECRET,
    fetch: async () => new Response('private diagnostics', { status: 403 }),
  });
  await assert.rejects(
    FrayOhttpClient.create(publicKeys).send({ v: 3 }, { relayUrl, fetch: relay }),
    /rejected/,
  );
});

test('client bounds the encrypted response', async () => {
  const client = FrayOhttpClient.create(publicKeys);
  await assert.rejects(
    client.send(
      { v: 3 },
      {
        relayUrl,
        fetch: async () =>
          new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1), {
            headers: { 'content-type': RESPONSE_TYPE },
          }),
      },
    ),
  );
});

test('interop: decapsulates the published RFC 9458 Appendix A ciphertext', async () => {
  // Public specification vector, not a live key. https://www.rfc-editor.org/rfc/rfc9458.html#appendix-A
  const hex = (value: string) => new Uint8Array(Buffer.from(value, 'hex'));
  const suite = new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256, KDF_HKDF_SHA256, AEAD_AES_128_GCM);
  const key = await KeyConfig.import(
    suite,
    1,
    hex('31e1f05a740102115220e9af918f738674aec95f54db6e04eb705aae8e798155'),
    hex('3c168975674b2fa8e465970b79c8dcf09f1c741626480bd4c6162fc5b6a98e1a'),
  );
  const server = new OHTTPServer([key]);
  const { request } = await server.decapsulate(
    hex(
      '010020000100014b28f881333e7c164ffc499ad9796f877f4e1051ee6d31bad1' +
        '9dec96c208b4726374e469135906992e1268c594d2a10c695d858c40a026e796' +
        '5e7d86b83dd440b2c0185204b4d63525',
    ),
  );
  assert.equal(
    Buffer.from(request).toString('hex'),
    '00034745540568747470730b6578616d706c652e636f6d012f',
  );
});
