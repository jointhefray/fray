// Issuer side of RFC 9474 RSABSSA-SHA384-PSS-Deterministic: BlindSign (§4.3). PSS encoding,
// blinding and finalization stay client-side. Each epoch has four keys, one per metadata
// value, so a token's value is carried by which key signed it.

import { constants, privateDecrypt, type KeyObject } from 'node:crypto';

export const SUITE = 'RSABSSA-SHA384-PSS-Deterministic';

/** One of four issuer-defined values. The protocol does not publish their meanings. */
export type TokenMeta = 0 | 1 | 2 | 3;
export const TOKEN_META_VALUES: readonly TokenMeta[] = [0, 1, 2, 3];

export function isTokenMeta(value: unknown): value is TokenMeta {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3;
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt('0x' + Buffer.from(bytes).toString('hex'));
}

export function bigIntToBytes(value: bigint, length: number): Buffer {
  const hex = value.toString(16);
  if (value < 0n || hex.length > length * 2) {
    throw new Error('integer too large');
  }

  return Buffer.from(hex.padStart(length * 2, '0'), 'hex');
}

export function modInverse(value: bigint, modulus: bigint): bigint {
  let [r0, r1] = [((value % modulus) + modulus) % modulus, modulus];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) {
    const quotient = r0 / r1;
    [r0, r1] = [r1, r0 - quotient * r1];
    [s0, s1] = [s1, s0 - quotient * s1];
  }

  if (r0 !== 1n) {
    throw new Error('no modular inverse');
  }

  return ((s0 % modulus) + modulus) % modulus;
}

/**
 * BlindSign: RSASP1 by OpenSSL's raw private operation (CRT with RSA blinding), using the
 * private key of the request's metadata value.
 *
 * Fault protection (spec/protocol.md §2) is OpenSSL's internal check, not code here: inside
 * the private operation OpenSSL raises the CRT result to e mod n, compares it with the input
 * and, on a mismatch, recomputes without CRT, so a faulty CRT half never leaves the process.
 * An explicit RSAVP1 here would repeat that work. test/rsabssa.test.ts injects a CRT fault
 * and fails if a future OpenSSL stops checking; then add an explicit s^e mod n check here.
 */
export function blindSign(signingKey: KeyObject, blindedMessage: Buffer): Buffer {
  const signature = privateDecrypt(
    { key: signingKey, padding: constants.RSA_NO_PADDING },
    blindedMessage,
  );
  if (signature.length !== blindedMessage.length) {
    throw new Error('signing failure');
  }

  return signature;
}
