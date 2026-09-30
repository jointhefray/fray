import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { IssuanceError, type PrivacyTokenIssuer } from './issuer.js';

/** Optional HTTP adapter. Authentication and issuance policy live in the service. */
export async function buildServer(
  issuer: PrivacyTokenIssuer<FastifyRequest>,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  await issuer.initialize();

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof IssuanceError) {
      return reply.code(error.status).send({ error: error.code });
    }

    // Do not echo request bodies, credentials, or internal errors.
    const code =
      error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    const status = code === 413 ? 413 : code === 400 ? 400 : 500;

    return reply.code(status).send({ error: status === 500 ? 'internal_error' : 'bad_request' });
  });

  app.get('/.well-known/jwks.json', async (_request, reply) => {
    reply.header('cache-control', 'public, max-age=3600');
    return issuer.publishKeys();
  });

  app.post('/issue', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return issuer.issue(request, request.body);
  });

  return app;
}
