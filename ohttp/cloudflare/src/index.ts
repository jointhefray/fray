import { connect } from 'cloudflare:sockets';
import { createRelay } from '../../typescript/src/relay.js';
import { createTlsTransport } from './tls-transport.js';

interface Env {
  GATEWAY_URL: string;
  GATEWAY_KEYS_URL?: string;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return createRelay({
      gatewayUrl: env.GATEWAY_URL,
      keysUrl: env.GATEWAY_KEYS_URL,
      // Ordinary Worker fetch adds platform identity headers even to a new Request.
      // A TLS socket sends only the fixed HTTP message assembled by this adapter.
      fetch: createTlsTransport(connect),
    })(request);
  },
};
