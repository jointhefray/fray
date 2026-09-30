import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { PrivacyTokenIssuer, DailyQuota, buildServer } from './index.js';
import { configFromEnv } from './config.js';

const config = configFromEnv();

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

const issuer = new PrivacyTokenIssuer({
  keysDir: config.keysDir,
  validateUser,
  quota: new DailyQuota(config.dailyQuota),
  maxBatch: config.maxBatch,
});

const server = await buildServer(issuer);
await server.listen({ host: config.host, port: config.port });

process.stderr.write(
  `LOCAL DEMO issuer listening on ${config.host}:${config.port}; replace validateUser before deployment.\n`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close();
  });
}
