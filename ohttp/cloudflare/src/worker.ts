import { createRelay } from '../../typescript/src/relay.js';
import { response } from '../../typescript/src/http.js';
import { createTlsTransport, type Connector } from './tls-transport.js';

export interface Env {
  GATEWAY_URL: string;
  GATEWAY_KEYS_URL?: string;
  /** Shared secret sent as Fray-Relay-Auth. Set with `wrangler secret put FRAY_RELAY_AUTH`. */
  FRAY_RELAY_AUTH?: string;
}

type CfRequest = Request & { cf?: { country?: unknown } };

/** The Worker, with its socket connector injectable for workerd tests. */
export function createWorker(connect: Connector) {
  return {
    fetch(request: Request, env: Env): Promise<Response> {
      let relay;

      try {
        relay = createRelay({
          gatewayUrl: env.GATEWAY_URL,
          keysUrl: env.GATEWAY_KEYS_URL,
          relayAuth: env.FRAY_RELAY_AUTH,
          // Cloudflare's IP geolocation. Only the derived alpha-2 code leaves the Worker.
          country: (incoming) => (incoming as CfRequest).cf?.country,
          // Ordinary Worker fetch adds platform identity headers even to a new Request.
          // A TLS socket sends only the fixed HTTP message assembled by this adapter.
          fetch: createTlsTransport(connect),
        });
      } catch {
        // Missing or invalid configuration (including FRAY_RELAY_AUTH): forward nothing.
        return Promise.resolve(response(null, 503));
      }

      return relay(request);
    },
  };
}
