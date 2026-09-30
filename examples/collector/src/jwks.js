// Per-issuer JWKS fetch + cache, kid-indexed (protocol.md §6 step 3).
//
// Cache TTL is 6h by default: epoch keys change monthly, so a stale cache
// window is harmless — except right after rotation, when clients hold tokens
// under a kid we have not seen. Hence the "unknown kid" refetch below, rate
// limited so a flood of bogus kids cannot turn us into a JWKS-hammering client.

const EXPECTED_ALG = 'RSABSSA-SHA384-PSS-Deterministic';
const KID_RE = /^ep-\d{4}-\d{2}$/;
const MIN_REFETCH_INTERVAL_MS = 60_000;

export class JwksCache {
  /** issuerName -> { fetchedAt, keys: Map<kid, CryptoKey> } */
  #cache = new Map();

  constructor(ttlMs = 6 * 3600 * 1000, fetchImpl = fetch) {
    this.ttlMs = ttlMs;
    this.fetch = fetchImpl;
  }

  async #refresh(issuerName, jwksBase) {
    const res = await this.fetch(`${jwksBase}/.well-known/jwks.json`);
    if (!res.ok) throw new Error(`jwks fetch for ${issuerName}: ${res.status}`);
    const doc = await res.json();
    const keys = new Map();
    for (const jwk of doc.keys ?? []) {
      // Only keys that could possibly verify our tokens get imported; anything
      // else in the document is ignored, not an error.
      if (jwk.kty !== 'RSA' || jwk.use !== 'sig' || jwk.alg !== EXPECTED_ALG) continue;
      if (typeof jwk.kid !== 'string' || !KID_RE.test(jwk.kid)) continue;
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: jwk.kty, n: jwk.n, e: jwk.e },
        { name: 'RSA-PSS', hash: 'SHA-384' },
        true,
        ['verify'],
      );
      keys.set(jwk.kid, key);
    }
    const entry = { fetchedAt: Date.now(), keys };
    this.#cache.set(issuerName, entry);
    return entry;
  }

  /** Public key for (issuer, kid), or null if the issuer does not publish it. */
  async keyFor(issuerName, jwksBase, kid) {
    let entry = this.#cache.get(issuerName);
    const expired = !entry || Date.now() - entry.fetchedAt > this.ttlMs;
    const unknownKid = entry && !entry.keys.has(kid);
    const refetchable = !entry || Date.now() - entry.fetchedAt > MIN_REFETCH_INTERVAL_MS;
    if (expired || (unknownKid && refetchable)) {
      entry = await this.#refresh(issuerName, jwksBase);
    }
    return entry.keys.get(kid) ?? null;
  }
}
