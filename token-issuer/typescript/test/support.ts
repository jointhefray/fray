// Test-only helpers. Keys come from the committed TEST ONLY fixtures in ../../test-fixtures.

import { createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { writeEpochKey } from '../src/keys.js';
import { TOKEN_META_VALUES, bigIntToBytes, modInverse, type TokenMeta } from '../src/rsabssa.js';

const fixtures = new URL('../../test-fixtures/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));

export const hex = (value: string) => (value ? BigInt('0x' + value) : 0n);

/** TEST ONLY: two sets (two epochs) of four RSA-2048 keys, indexed [set][meta]. */
const fixtureKeys = read('test-only-rsabssa-keys.json').keys as Array<{
  set: number;
  meta: number;
  p: string;
  q: string;
}>;
export const TEST_KEYS = [0, 1].map((set) =>
  TOKEN_META_VALUES.map((meta) => {
    const key = fixtureKeys.find((k) => k.set === set && k.meta === meta)!;
    return { p: hex(key.p), q: hex(key.q), n: hex(key.p) * hex(key.q) };
  }),
);

/** RFC 9474 Appendix A.3 (RSABSSA-SHA384-PSS-Deterministic). */
export const RFC_VECTOR = read('rfc9474-a3-test-vector.json').vector as Record<string, string>;

const b64u = (value: bigint) =>
  bigIntToBytes(value, Math.ceil(value.toString(16).length / 2)).toString('base64url');

/** A private JWK from p, q and e, optionally with a corrupted CRT exponent. */
export function privateJwk(p: bigint, q: bigint, e = 65537n, fault: 'none' | 'dp' | 'dq' = 'none') {
  const d = modInverse(e, (p - 1n) * (q - 1n));
  const dp = d % (p - 1n);
  const dq = d % (q - 1n);
  return {
    kty: 'RSA',
    n: b64u(p * q),
    e: b64u(e),
    d: b64u(d),
    p: b64u(p),
    q: b64u(q),
    dp: b64u(fault === 'dp' ? dp ^ 2n : dp),
    dq: b64u(fault === 'dq' ? dq ^ 2n : dq),
    qi: b64u(modInverse(q, p)),
  };
}

export function testKeyObject(set: number, meta: TokenMeta): KeyObject {
  const { p, q } = TEST_KEYS[set][meta];
  return createPrivateKey({ format: 'jwk', key: privateJwk(p, q) });
}

/** Write a fixture set's keys for `metas` (default: all four) as `epoch`'s key files. */
export async function writeTestEpoch(
  keysDir: string,
  epoch: string,
  set = 0,
  metas: readonly TokenMeta[] = TOKEN_META_VALUES,
): Promise<void> {
  for (const meta of metas) {
    await writeEpochKey(keysDir, epoch, meta, testKeyObject(set, meta));
  }
}

export const suite = RSABSSA.SHA384.PSS.Deterministic();

/** WebCrypto RSA-PSS key for @cloudflare/blindrsa-ts's reference blindSign. */
export function referencePrivateKey(set: number, meta: TokenMeta): Promise<CryptoKey> {
  const { p, q } = TEST_KEYS[set][meta];
  return crypto.subtle.importKey(
    'jwk',
    { ...privateJwk(p, q), alg: 'PS384', ext: true },
    { name: 'RSA-PSS', hash: 'SHA-384' },
    true,
    ['sign'],
  );
}

export function importPublicJwk(jwk: { kty: string; n: string; e: string }): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e },
    { name: 'RSA-PSS', hash: 'SHA-384' },
    true,
    ['verify'],
  );
}

/** The library reads `.buffer`, so give it plain Uint8Arrays rather than pooled Buffers. */
export const u8 = (bytes: Uint8Array) => new Uint8Array(bytes);
