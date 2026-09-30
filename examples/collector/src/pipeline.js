// The verification pipeline, exactly in the order of protocol.md §6:
//   schema → issuer allowlist → kid window → signature → spent-set burn →
//   watchlist → quorum → triage → candidate.
// Rejections never persist an envelope. A token may already be burned if a
// later watchlist check rejects the report.
import { createHash } from 'node:crypto';
import { RSABSSA } from '@cloudflare/blindrsa-ts';

const suite = RSABSSA.SHA384.PSS.Deterministic();

const COUNTRY_RE = /^[A-Z]{2}$/;

export function epochIdFor(date = new Date()) {
  return `ep-${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function previousEpochIdFor(date = new Date()) {
  return epochIdFor(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)));
}

const sha256hex = (data) => createHash('sha256').update(data).digest('hex');

/** protocol.md §6 step 7: SHA-256(lowercase(NFC(title))). */
export function creativeHash(title) {
  return sha256hex(title.normalize('NFC').toLowerCase());
}

/** V2 grouping excludes page-scoped batch/at values and uses a stable advertiser identity. */
export function lookupReportHash(envelope) {
  const identity = envelope.advertiser.id
    ? ['id', envelope.advertiser.id]
    : [
        'name',
        envelope.advertiser.name.normalize('NFC').toLowerCase(),
        envelope.advertiser.country?.normalize('NFC').toLowerCase() ?? '',
      ];
  const creative = envelope.creative
    ? envelope.creative.title.normalize('NFC').toLowerCase()
    : null;

  return sha256hex(JSON.stringify(['lookup-v2', envelope.observed_domain, identity, creative]));
}

/**
 * @param {object} deps
 * @param {import('redis').RedisClientType} deps.redis
 * @param {Map<string,string>} deps.issuers  token.issuer -> JWKS base URL
 * @param {import('./jwks.js').JwksCache} deps.jwksCache
 * @param {{version:number, expires:string, entries:Array<{domain:string}>}} deps.watchlist local watchlist copy
 * @param {(data:unknown)=>boolean} deps.validateEnvelope compiled ajv validator
 * @param {object} deps.cfg config from config.js
 */
export function createPipeline({ redis, issuers, jwksCache, watchlist, validateEnvelope, cfg }) {
  const watchedBrands = new Set(watchlist.entries.map((e) => e.domain));

  return async function process(wrapper) {
    // 0. Gateway wrapper shape (envelope.md: the OHTTP gateway forwards
    //    {country:"ZZ", envelope}; clients do not supply geography).
    if (
      wrapper === null ||
      typeof wrapper !== 'object' ||
      typeof wrapper.country !== 'string' ||
      !COUNTRY_RE.test(wrapper.country) ||
      wrapper.envelope === undefined
    ) {
      return { accepted: false, reason: 'bad_wrapper' };
    }
    const { country, envelope } = wrapper;

    // 1. Schema validation against the normative /spec/envelope.schema.json.
    //    additionalProperties:false everywhere means any smuggled field —
    //    including any geo field a client tried to set — is a rejection.
    if (!validateEnvelope(envelope)) {
      return { accepted: false, reason: 'schema' };
    }

    if (envelope.v === 2) {
      const observed = new Date(envelope.observed_hour);
      if (
        !Number.isFinite(observed.getTime()) ||
        observed.toISOString() !== envelope.observed_hour.replace('Z', '.000Z')
      ) {
        return { accepted: false, reason: 'schema' };
      }

      if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > 8 * 1024 - 128) {
        return { accepted: false, reason: 'too_large' };
      }
    }

    const { token, creative } = envelope;

    // 2. Issuer allowlist: only configured partners' tokens count.
    const jwksBase = issuers.get(token.issuer);
    if (!jwksBase) {
      return { accepted: false, reason: 'unknown_issuer' };
    }

    // 3. Kid acceptance window: current or previous calendar month (UTC),
    //    evaluated at receipt. Older epochs are dead (protocol.md §3).
    const now = new Date();
    if (token.kid !== epochIdFor(now) && token.kid !== previousEpochIdFor(now)) {
      return { accepted: false, reason: 'token_expired' };
    }

    // 4. RSABSSA verification against the issuer's published epoch key.
    const msg = Buffer.from(token.msg, 'base64');
    const sig = Buffer.from(token.sig, 'base64');
    if (msg.length !== 32) {
      return { accepted: false, reason: 'bad_signature' }; // token message is 32 bytes, protocol.md §2
    }
    let publicKey;
    try {
      publicKey = await jwksCache.keyFor(token.issuer, jwksBase, token.kid);
    } catch {
      // The issuer's JWKS being unreachable is an availability problem, not a
      // reason to accept unverifiable tokens.
      return { accepted: false, reason: 'jwks_unavailable' };
    }
    if (!publicKey) {
      return { accepted: false, reason: 'unknown_key' };
    }
    const valid = await suite
      .verify(publicKey, new Uint8Array(sig), new Uint8Array(msg))
      .catch(() => false);
    if (!valid) {
      return { accepted: false, reason: 'bad_signature' };
    }

    // 5. Burn the token: atomic set-if-absent with TTL (protocol.md §6 step 5).
    //    The spent-set key is SHA-256(msg) — the token identifier — with a TTL
    //    that outlives the key acceptance window (70d), after which the epoch
    //    key is dead and the entry is garbage.
    const spent = await redis.set(`tok:${sha256hex(msg)}`, '1', {
      NX: true,
      EX: cfg.spentTtlSeconds,
    });
    if (spent === null) {
      return { accepted: false, reason: 'token_reused' };
    }

    // 6. Watchlist sanity: the claimed version must be the current local copy
    //    or the immediately previous one (clients refresh daily; older claims
    //    mean a stale or lying client), and the brand must actually be watched.
    if (
      envelope.watchlist_version !== watchlist.version &&
      envelope.watchlist_version !== watchlist.version - 1
    ) {
      return { accepted: false, reason: 'stale_watchlist' };
    }
    if (!watchedBrands.has(envelope.brand)) {
      return { accepted: false, reason: 'unknown_brand' };
    }

    if (envelope.v === 2) {
      const expires = Date.parse(watchlist.expires);
      if (!Number.isFinite(expires) || expires <= now.getTime()) {
        return { accepted: false, reason: 'stale_watchlist' };
      }

      // V2 is domain-only. Displayed primary brand domains still match; aliases
      // are not silently added, and a brand-term hit alone is insufficient.
      if (
        envelope.observed_domain !== envelope.brand &&
        !envelope.observed_domain.endsWith(`.${envelope.brand}`)
      ) {
        return { accepted: false, reason: 'unmatched_domain' };
      }
    }

    // 7. Quorum: count distinct-token sightings of (brand, creative, country,
    //    UTC day). K approximates K distinct clients — enforced economically
    //    (quota × account cost), not cryptographically; protocol.md §7 says to
    //    state that wherever K is cited, so: stated.
    const day = envelope.observed_hour.slice(0, 10);
    const chash = envelope.v === 2 ? lookupReportHash(envelope) : creativeHash(creative.title);
    const quorumKey = `q:${envelope.brand}|${chash}|${country}|${day}`;
    const count = await redis.incr(quorumKey);
    if (count === 1) {
      await redis.expire(quorumKey, cfg.quorumTtlSeconds);
    }

    // 7b. Triage (protocol.md §6 step 7 and §6.1): the FIRST sighting of a
    //     new (brand, creative_hash) enters the analyst triage queue.
    //     V1 creative text is sanitized client-side. V2 deliberately retains
    //     page-scoped lookup values and must be handled as correlatable data.
    //     Review starts at sighting one; cloaked and targeted scam ads are often visible only
    //     to the users they target, so a single sighting must be reviewable.
    //     The NX flag makes "first" atomic under concurrent submissions.
    const firstSeen = await redis.set(`seen:${envelope.brand}|${chash}`, '1', {
      NX: true,
      EX: cfg.triageSeenTtlSeconds,
    });
    if (firstSeen !== null) {
      await redis.lPush(
        'triage',
        JSON.stringify({
          brand: envelope.brand,
          creative_hash: chash,
          country,
          day,
          watchlist_version: envelope.watchlist_version,
        }),
      );
    }

    // 8. At K, auto-escalate ONE candidate. Independent reproduction and
    //    recording the result are operator responsibilities outside this
    //    pipeline (protocol.md §6 step 8, §6.1). K is an
    //    auto-escalation quorum, not a review gate: triage above sees
    //    sightings from the first one, K prioritizes attention. The NX flag
    //    key makes "once" atomic even with concurrent submissions racing
    //    past K.
    if (count >= cfg.quorumK) {
      const flag = await redis.set(`cand:${quorumKey}`, '1', {
        NX: true,
        EX: cfg.quorumTtlSeconds,
      });
      if (flag !== null) {
        await redis.rPush(
          'candidates',
          JSON.stringify({
            brand: envelope.brand,
            creative_hash: chash,
            country,
            day,
            watchlist_version: envelope.watchlist_version,
            reached_k: cfg.quorumK,
            enqueued_at: new Date().toISOString(),
          }),
        );
      }
    }

    // 9. Reference persistence: the accepted envelope, keyed by token id, for
    //    RAW_RETENTION = 90 days (protocol.md §5). Note what is NOT stored:
    //    no client IP or added receipt timestamp, nothing about rejected submissions.
    //    V2 retains the complete lookup data, including atParameter's precise
    //    timestamp. OHTTP does not anonymize those payload values.
    await redis.set(`env:${sha256hex(msg)}`, JSON.stringify(envelope), {
      EX: cfg.rawRetentionSeconds,
    });

    return { accepted: true };
  };
}
