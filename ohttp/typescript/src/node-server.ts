import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import type { Fetcher } from './http.js';

/** Small Node adapter; request data, addresses, and timestamps are never logged. */
export function serve(handler: Fetcher, port: number, host = '0.0.0.0'): Server {
  const server = createServer({ maxHeaderSize: 8192 }, async (incoming, outgoing) => {
    try {
      const headers = new Headers();

      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }

      const method = incoming.method ?? 'GET';
      const init = {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : Readable.toWeb(incoming),
        duplex: 'half',
      } as RequestInit;

      const result = await handler(
        new Request(new URL(incoming.url ?? '/', 'http://local.invalid'), init),
      );

      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      outgoing.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(400, { 'cache-control': 'no-store' });

      outgoing.end();
    }
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  server.listen(port, host);

  return server;
}
