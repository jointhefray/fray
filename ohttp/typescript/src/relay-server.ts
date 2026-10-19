import { createRelay } from './relay.js';
import { trustedCountryHeader } from './metadata.js';
import { serve } from './node-server.js';

if (!process.env.GATEWAY_URL) throw new Error('Set GATEWAY_URL to the gateway /ohttp endpoint');

// createRelay refuses to start without a valid FRAY_RELAY_AUTH.
serve(
  createRelay({
    gatewayUrl: process.env.GATEWAY_URL,
    keysUrl: process.env.GATEWAY_KEYS_URL,
    relayAuth: process.env.FRAY_RELAY_AUTH,
    country: trustedCountryHeader(process.env.FRAY_COUNTRY_HEADER),
    allowHttp: process.env.ALLOW_INSECURE_HTTP === 'true',
  }),
  Number(process.env.PORT ?? 8788),
);
