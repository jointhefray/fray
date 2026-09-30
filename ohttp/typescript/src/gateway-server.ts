import { readFile } from 'node:fs/promises';
import { importKeys, type StoredKey } from './crypto.js';
import { createGateway } from './gateway.js';
import { serve } from './node-server.js';

if (!process.env.OHTTP_KEY_FILE || !process.env.COLLECTOR_URL) {
  throw new Error('Set OHTTP_KEY_FILE and COLLECTOR_URL (the collector /v1/events endpoint)');
}

const stored = JSON.parse(await readFile(process.env.OHTTP_KEY_FILE, 'utf8')) as StoredKey[];
const keys = await importKeys(stored);

serve(
  createGateway({
    keys,
    collectorUrl: process.env.COLLECTOR_URL,
    allowHttp: process.env.ALLOW_INSECURE_HTTP === 'true',
  }),
  Number(process.env.PORT ?? 8789),
);
