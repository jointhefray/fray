import { createClient } from 'redis';

import { configFromEnv } from './config.js';
import { buildServer } from './server.js';

const cfg = configFromEnv();
const redis = createClient({ url: cfg.redisUrl });
redis.on('error', (err) => {
  process.stderr.write(`redis: ${err.message}\n`);
});
await redis.connect();

const app = await buildServer(cfg, redis);
await app.listen({ host: cfg.host, port: cfg.port });
process.stdout.write(
  JSON.stringify({
    ts: new Date().toISOString(),
    event: 'listening',
    host: cfg.host,
    port: cfg.port,
  }) + '\n',
);
