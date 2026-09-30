import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AEAD_AES_128_GCM, CipherSuite, KDF_HKDF_SHA256, KEM_DHKEM_X25519_HKDF_SHA256 } from 'hpke';
import { KeyConfig, OHTTPServer } from 'ohttp-ts';
import { FrayOhttpClient } from '../src/client.js';
import { cipherSuite } from '../src/crypto.js';
import { createRelay } from '../src/relay.js';
import { INNER_TARGET } from '../src/http.js';

test('client encrypts reports through an opaque relay and decrypts reference responses', async () => {
  const keys = [await KeyConfig.generate(cipherSuite(), 1)];
  const publicKeys = KeyConfig.serializeMultiple(keys);
  const referenceServer = new OHTTPServer(keys);
  const envelope = { evidence: 'not-visible-to-relay', token: 'one-use-token' };
  const ciphertexts: Uint8Array[] = [];
  const relay = createRelay({
    gatewayUrl: 'https://gateway.example/ohttp',
    fetch: async (request) => {
      ciphertexts.push(new Uint8Array(await request.clone().arrayBuffer()));
      const decoded = await referenceServer.decapsulateRequest(request);
      assert.equal(decoded.request.url, INNER_TARGET);
      assert.equal(decoded.request.method, 'POST');
      assert.deepEqual(Object.fromEntries(decoded.request.headers), {
        'content-type': 'application/json',
      });
      assert.deepEqual(await decoded.request.json(), envelope);
      return decoded.context.encapsulateResponse(new Response(null, { status: 200 }));
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
  assert.equal(ciphertexts.length, 2);
  assert.notDeepEqual(ciphertexts[0], ciphertexts[1]);
  assert.equal(new TextDecoder().decode(ciphertexts[0]).includes(envelope.evidence), false);
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
