import { createRelay } from './relay.js';
import { serve } from './node-server.js';

if (!process.env.GATEWAY_URL) throw new Error('Set GATEWAY_URL to the gateway /ohttp endpoint');

serve(
  createRelay({
    gatewayUrl: process.env.GATEWAY_URL,
    keysUrl: process.env.GATEWAY_KEYS_URL,
    allowHttp: process.env.ALLOW_INSECURE_HTTP === 'true',
  }),
  Number(process.env.PORT ?? 8788),
);
