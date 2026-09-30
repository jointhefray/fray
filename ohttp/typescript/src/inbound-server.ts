import { createInbound, loadInboundKeys } from './inbound.js';
import { serve } from './node-server.js';

const keys = await loadInboundKeys(process.env.OHTTP_KEYS_JSON);
const port = Number(process.env.PORT ?? 8789);

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');

const server = serve(createInbound({ keys }), port);

// Heroku sends SIGTERM when replacing a dyno. Finish active requests before exit.
process.once('SIGTERM', () => {
  server.close();
  setTimeout(() => process.exit(0), 10_000).unref();
});
