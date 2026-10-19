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

      const body = Buffer.from(await result.arrayBuffer());
      const responseHeaders: Record<string, string> = Object.fromEntries(result.headers);

      // A handler that rejects a request (e.g. 413) before reading its whole body leaves the
      // rest on the socket; reusing that connection would misparse it, so close it instead.
      if (!incoming.complete) responseHeaders.connection = 'close';

      outgoing.writeHead(result.status, responseHeaders);
      outgoing.end(body);
    } catch {
      if (!outgoing.headersSent) {
        outgoing.writeHead(400, {
          'cache-control': 'no-store',
          ...(incoming.complete ? {} : { connection: 'close' }),
        });
      }

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
