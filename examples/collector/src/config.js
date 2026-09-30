// Collector configuration from environment, with reference defaults.
// Parameter values are protocol.md §5 — change them there first or not at all.
import { fileURLToPath } from 'node:url';

/** Parse `ISSUERS="issuer.partner.example=https://issuer.partner.example,..."`
 *  (logical issuer name, as carried in token.issuer → JWKS base URL). This is
 *  the partner allowlist of protocol.md §6 step 2. */
export function parseIssuers(spec) {
  const issuers = new Map();
  for (const part of (spec ?? '').split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0 || idx === trimmed.length - 1) {
      throw new Error(`ISSUERS entry is not "name=url": ${JSON.stringify(trimmed)}`);
    }
    issuers.set(trimmed.slice(0, idx), trimmed.slice(idx + 1).replace(/\/$/, ''));
  }
  if (issuers.size === 0) throw new Error('set ISSUERS="issuer.host=https://jwks-base,..."');
  return issuers;
}

export function configFromEnv(env = process.env) {
  return {
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 8082),
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    issuers: parseIssuers(env.ISSUERS),
    // The normative schema lives in /spec; the Docker image copies it in at
    // build so the deployed artifact validates against the same bytes.
    envelopeSchemaPath:
      env.ENVELOPE_SCHEMA_PATH ??
      fileURLToPath(new URL('../../../spec/envelope.schema.json', import.meta.url)),
    // Local copy of the published watchlist (protocol.md §6 step 6).
    watchlistPath:
      env.WATCHLIST_PATH ?? fileURLToPath(new URL('../watchlist.sample.json', import.meta.url)),
    quorumK: Number(env.QUORUM_K ?? 3), // protocol.md §5: K = 3
    spentTtlSeconds: Number(env.SPENT_TTL_SECONDS ?? 6048000), // 70 days — outlives the key acceptance window
    quorumTtlSeconds: Number(env.QUORUM_TTL_SECONDS ?? 2592000), // 30 days
    triageSeenTtlSeconds: Number(env.TRIAGE_SEEN_TTL_SECONDS ?? 2592000), // 30 days: seen:<brand>|<creative_hash> triage dedup flag
    rawRetentionSeconds: Number(env.RAW_RETENTION_SECONDS ?? 7776000), // 90 days (protocol.md §5 RAW_RETENTION)
    jwksTtlMs: Number(env.JWKS_TTL_MS ?? 6 * 3600 * 1000), // 6h JWKS cache
  };
}
