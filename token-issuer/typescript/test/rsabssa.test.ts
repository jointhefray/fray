import assert from 'node:assert/strict';
import { createPrivateKey, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  TOKEN_META_VALUES,
  bigIntToBytes,
  blindSign,
  bytesToBigInt,
  isTokenMeta,
  modInverse,
} from '../src/rsabssa.js';
import {
  RFC_VECTOR,
  TEST_KEYS,
  hex,
  importPublicJwk,
  privateJwk,
  referencePrivateKey,
  suite,
  testKeyObject,
  u8,
} from './support.js';

test('RFC 9474 A.3 vector: BlindSign and the finalized signature', async () => {
  const [p, q, n] = [RFC_VECTOR.p, RFC_VECTOR.q, RFC_VECTOR.n].map(hex);
  assert.equal(p * q, n);
  const kLen = RFC_VECTOR.n.length / 2;
  const signingKey = createPrivateKey({ format: 'jwk', key: privateJwk(p, q) });
  const blindSig = blindSign(signingKey, Buffer.from(RFC_VECTOR.blinded_msg, 'hex'));
  assert.equal(blindSig.toString('hex'), RFC_VECTOR.blind_sig);

  const sig = bigIntToBytes((bytesToBigInt(blindSig) * hex(RFC_VECTOR.inv)) % n, kLen);
  assert.equal(sig.toString('hex'), RFC_VECTOR.sig);
  const publicKey = await importPublicJwk({
    kty: 'RSA',
    n: bigIntToBytes(n, kLen).toString('base64url'),
    e: 'AQAB',
  });
  const msg = u8(Buffer.from(RFC_VECTOR.msg, 'hex'));
  assert.equal(await suite.verify(publicKey, u8(sig), msg), true);
  assert.equal(await suite.verify(publicKey, u8(sig), u8(randomBytes(32))), false);
});

test('native BlindSign equals @cloudflare/blindrsa-ts blindSign for each metadata key', async () => {
  for (const meta of TOKEN_META_VALUES) {
    const blinded = bigIntToBytes(bytesToBigInt(randomBytes(256)) % TEST_KEYS[0][meta].n, 256);
    const ours = blindSign(testKeyObject(0, meta), blinded);
    const theirs = await suite.blindSign(await referencePrivateKey(0, meta), u8(blinded));
    assert.equal(ours.toString('hex'), Buffer.from(theirs).toString('hex'));
  }
});

/** Square-and-multiply with BigInt: an expected value computed without OpenSSL. */
function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  for (base %= modulus; exponent > 0n; exponent >>= 1n, base = (base * base) % modulus) {
    if (exponent & 1n) result = (result * base) % modulus;
  }
  return result;
}

test('fault protection: OpenSSL verifies the RSA-CRT result inside the private operation', () => {
  for (const meta of TOKEN_META_VALUES) {
    const { p, q, n } = TEST_KEYS[0][meta];
    const d = modInverse(65537n, (p - 1n) * (q - 1n));
    const m = bytesToBigInt(randomBytes(256)) % n;
    const expected = modPow(m, d, n);
    for (const fault of ['none', 'dp', 'dq'] as const) {
      // A corrupted CRT exponent makes that half of the CRT computation wrong.
      const signingKey = createPrivateKey({ format: 'jwk', key: privateJwk(p, q, 65537n, fault) });
      assert.equal(
        bytesToBigInt(blindSign(signingKey, bigIntToBytes(m, 256))),
        expected,
        `key ${meta}, fault in ${fault}: this OpenSSL returned a wrong RSA-CRT result, so it ` +
          `no longer verifies the private operation internally. blindSign must add an explicit ` +
          `s^e mod n verification (spec/protocol.md §2, Fault protection).`,
      );
    }
  }
});

test('metadata values are the integers 0 to 3 only', () => {
  assert.deepEqual([...TOKEN_META_VALUES], [0, 1, 2, 3]);
  for (const good of [0, 1, 2, 3]) assert.equal(isTokenMeta(good), true);
  for (const bad of [-1, 4, 1.5, NaN, '1', null, true, [1]]) assert.equal(isTokenMeta(bad), false);
});
