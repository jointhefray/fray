import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AEAD_AES_128_GCM, CipherSuite, KDF_HKDF_SHA256, KEM_DHKEM_X25519_HKDF_SHA256 } from 'hpke';
import { KeyConfig, OHTTPClient, OHTTPServer } from 'ohttp-ts';
import { FrayOhttpClient } from '../src/client.js';
import { cipherSuite } from '../src/crypto.js';
import { createGateway } from '../src/gateway.js';
import { createRelay } from '../src/relay.js';
import { INNER_TARGET, REQUEST_TYPE } from '../src/http.js';

const keys = [await KeyConfig.generate(cipherSuite(), 1)];
const publicKeys = KeyConfig.serializeMultiple(keys);

test('encrypts report through relay and gateway, hides diagnostics and never forwards identity to collector', async () => {
  const envelope = { v: 1, advertiserId: 'not-visible-to-relay', token: 'one-use-token' };
  const ciphertexts: Uint8Array[] = [];
  let collected = 0;
  const gateway = createGateway({
    keys,
    collectorUrl: 'https://collector.example/v1/events',
    fetch: async (request) => {
      collected++;
      assert.equal(request.url, 'https://collector.example/v1/events');
      assert.deepEqual(Object.fromEntries(request.headers), { 'content-type': 'application/json' });
      assert.deepEqual(await request.json(), { country: 'ZZ', envelope });
      return Response.json({ accepted: false, reason: 'private-debug-value' });
    },
  });
  const relay = createRelay({
    gatewayUrl: 'https://gateway.example/ohttp',
    fetch: async (request) => {
      ciphertexts.push(new Uint8Array(await request.clone().arrayBuffer()));
      return gateway(request);
    },
  });
  const client = FrayOhttpClient.create(publicKeys);
  for (let i = 0; i < 2; i++) {
    const result = await client.send(envelope, {
      relayUrl: 'https://relay.example/ohttp',
      fetch: relay,
    });
    assert.equal(result.status, 200);
    assert.equal(await result.text(), '');
  }
  assert.equal(collected, 2);
  assert.notDeepEqual(ciphertexts[0], ciphertexts[1]);
  assert.equal(new TextDecoder().decode(ciphertexts[0]).includes(envelope.advertiserId), false);
});

test('gateway is not a general proxy; target, method, headers and malformed JSON are rejected inside encryption', async () => {
  let calls = 0;
  const gateway = createGateway({
    keys,
    collectorUrl: 'https://collector.example/v1/events',
    fetch: async () => {
      calls++;
      return new Response();
    },
  });
  const client = new OHTTPClient(cipherSuite(), KeyConfig.parseMultiple(publicKeys)[0]);
  for (const inner of [
    new Request('https://attacker.example/private', { method: 'POST', body: '{}' }),
    new Request(INNER_TARGET),
    new Request(INNER_TARGET, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'identity' },
      body: '{}',
    }),
    new Request(INNER_TARGET, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    }),
  ]) {
    const { init, context } = await client.encapsulateRequest(inner);
    const outer = await gateway(new Request('https://gateway.example/ohttp', init));
    assert.equal(outer.status, 200);
    assert.equal((await context.decapsulateResponse(outer)).status, 400);
  }
  assert.equal(calls, 0);
});

test('modified ciphertext and unknown keys produce the same empty 400', async () => {
  const gateway = createGateway({ keys, collectorUrl: 'https://collector.example/v1/events' });
  const client = new OHTTPClient(cipherSuite(), keys[0]);
  const { init } = await client.encapsulateRequest(
    new Request(INNER_TARGET, { method: 'POST', body: '{}' }),
  );
  const ciphertext = new Uint8Array(
    await new Request('https://gateway.example', init).arrayBuffer(),
  );
  const modified = ciphertext.slice();
  modified[modified.length - 1] ^= 1;
  const unknownKey = ciphertext.slice();
  unknownKey[0] = 99;
  for (const body of [modified, unknownKey, new Uint8Array([1, 2, 3])]) {
    const result = await gateway(
      new Request('https://gateway.example/ohttp', {
        method: 'POST',
        headers: { 'content-type': REQUEST_TYPE },
        body,
      }),
    );
    assert.equal(result.status, 400);
    assert.equal(await result.text(), '');
  }
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
