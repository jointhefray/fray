import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { PrivacyTokenIssuer, DailyQuota, buildServer, generateEpochKeys } from './index.js';
import { configFromEnv } from './config.js';
import { epochIdFor } from './epoch.js';

const config = configFromEnv();

// LOCAL DEMO convenience: create this month's four keys if they are missing. A production
// issuer never generates keys while serving; run the keygen command ahead of each month.
const keys = await generateEpochKeys(config.keysDir, epochIdFor(new Date()));
if (keys.created.length) {
  process.stderr.write(`LOCAL DEMO generated ${keys.created.join(', ')} in ${config.keysDir}.\n`);
}

// LOCAL MOCK: replace this function with your existing session/device auth.
// Return its stable internal subject for quotas, or null when validation fails.
// A credential embedded in a public extension is not user authentication.
async function validateUser(request: FastifyRequest): Promise<string | null> {
  const actual = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${config.token}`);

  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? 'local-demo-user'
    : null;
}

// LOCAL MOCK: replace with your own assignment of one of the four issuer-defined values.
function metaFor(_subject: string): number {
  return config.meta;
}

const issuer = new PrivacyTokenIssuer({
  keysDir: config.keysDir,
  validateUser,
  metaFor,
  quota: new DailyQuota(config.dailyQuota),
  maxBatch: config.maxBatch,
});

const server = await buildServer(issuer);
await server.listen({ host: config.host, port: config.port });

process.stderr.write(
  `LOCAL DEMO issuer listening on ${config.host}:${config.port}; replace validateUser and metaFor before deployment.\n`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close();
  });
}
