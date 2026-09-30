// Fastify wiring: POST /v1/events + GET /healthz.
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import Fastify from 'fastify';

import { JwksCache } from './jwks.js';
import { createPipeline } from './pipeline.js';

export async function buildServer(cfg, redis) {
  // Compile the NORMATIVE schema from /spec — the collector must never carry
  // its own drifted copy of the envelope shape.
  const schema = JSON.parse(await readFile(cfg.envelopeSchemaPath, 'utf8'));
  const ajv = new Ajv2020.default({ allErrors: false, strict: true });
  const validateEnvelope = ajv.compile(schema);

  const watchlist = JSON.parse(await readFile(cfg.watchlistPath, 'utf8'));
  if (watchlist.v !== 1 || !Number.isInteger(watchlist.version) || watchlist.version < 1) {
    throw new Error(`${cfg.watchlistPath} is not a v1 watchlist`);
  }

  const pipeline = createPipeline({
    redis,
    issuers: cfg.issuers,
    jwksCache: new JwksCache(cfg.jwksTtlMs),
    watchlist,
    validateEnvelope,
    cfg,
  });

  const app = Fastify({
    logger: false,
    // envelope.md §Size: the 8 KiB limit applies to the complete body,
    // including the gateway wrapper, before the verification pipeline.
    bodyLimit: 8 * 1024,
  });

  // Unparseable JSON is a rejection like any other: 200 with accepted:false,
  // for local debugging. The OHTTP gateway returns a generic encrypted response
  // to clients (protocol.md §6). Only an over-limit body breaks this pattern:
  // Fastify rejects it with 413 before the verification pipeline.
  app.setErrorHandler((error, _req, reply) => {
    if (error.statusCode === 413) {
      return reply.code(413).send({ accepted: false, reason: 'too_large' });
    }
    return reply.code(200).send({ accepted: false, reason: 'bad_body' });
  });

  app.post('/v1/events', async (req) => {
    // The body {accepted, reason} exists for debugging deployments only —
    // the OHTTP gateway discards it, clients never see it (protocol.md §6).
    return pipeline(req.body);
  });

  app.get('/healthz', async () => {
    let redisUp = false;
    try {
      redisUp = (await redis.ping()) === 'PONG';
    } catch {
      /* down */
    }
    return { ok: redisUp, redis: redisUp ? 'up' : 'down' };
  });

  return app;
}
