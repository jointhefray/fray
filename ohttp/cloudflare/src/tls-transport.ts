import { Buffer } from 'node:buffer';
import { HTTPParser } from 'http-parser-js';
import type { Socket } from 'cloudflare:sockets';
import {
  MAX_KEY_BYTES,
  MAX_MESSAGE_BYTES,
  readLimited,
  type Fetcher,
} from '../../typescript/src/http.js';

type Connector = (
  address: { hostname: string; port: number },
  options: { secureTransport: 'on' },
) => Socket;

const MAX_WIRE_BYTES = MAX_MESSAGE_BYTES + 8192;

/** Fixed-destination HTTPS over a Worker TLS socket, without fetch's automatic IP headers. */
export function createTlsTransport(connect: Connector): Fetcher {
  return async (request) => {
    const url = new URL(request.url);

    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('TLS gateway URL required');
    }

    const body =
      request.method === 'POST'
        ? await readLimited(request, MAX_MESSAGE_BYTES, request.signal)
        : new Uint8Array();

    if (request.method !== 'POST' && request.method !== 'GET')
      throw new Error('Unsupported method');

    const isKeys = request.method === 'GET';
    const lines = [
      `${request.method} ${url.pathname} HTTP/1.1`,
      `Host: ${url.host}`,
      'Connection: close',
      'Accept-Encoding: identity',
      `Accept: ${isKeys ? 'application/ohttp-keys' : 'message/ohttp-res'}`,
    ];

    if (!isKeys) lines.push('Content-Type: message/ohttp-req', `Content-Length: ${body.length}`);

    const preamble = new TextEncoder().encode(lines.join('\r\n') + '\r\n\r\n');
    const socket = connect(
      { hostname: url.hostname, port: Number(url.port || 443) },
      { secureTransport: 'on' },
    );

    // Socket errors carry connection details. Consume them, without emitting logs.
    void socket.closed.catch(() => {});

    const abort = () => {
      void socket.close().catch(() => {});
    };

    request.signal.addEventListener('abort', abort, { once: true });

    const reader = socket.readable.getReader();
    const writer = socket.writable.getWriter();

    try {
      request.signal.throwIfAborted();
      await socket.opened;

      await writer.write(preamble);
      if (body.length) await writer.write(body);

      const parser = new HTTPParser(HTTPParser.RESPONSE);
      parser.maxHeaderSize = 8192;

      const chunks: Uint8Array[] = [];
      let status = 0;
      let headers = new Headers();
      let complete = false;
      let wireBytes = 0;
      let bodyBytes = 0;

      parser[HTTPParser.kOnHeadersComplete] = (info) => {
        if (complete || info.statusCode === undefined || info.statusCode < 200)
          throw new Error('Unexpected response');

        status = info.statusCode;
        headers = new Headers();

        for (let i = 0; i < info.headers.length; i += 2)
          headers.append(info.headers[i], info.headers[i + 1]);

        if (headers.has('content-encoding') && headers.get('content-encoding') !== 'identity') {
          throw new Error('Encoded response rejected');
        }

        return 0;
      };

      parser[HTTPParser.kOnBody] = (bytes, start, length) => {
        bodyBytes += length;

        if (bodyBytes > (isKeys ? MAX_KEY_BYTES : MAX_MESSAGE_BYTES))
          throw new Error('Response too large');

        chunks.push(new Uint8Array(bytes.subarray(start, start + length)));
      };

      parser[HTTPParser.kOnMessageComplete] = () => {
        complete = true;
      };

      while (!complete) {
        const { done, value } = await reader.read();
        request.signal.throwIfAborted();

        if (done) {
          const error = parser.finish();
          if (error || !complete) throw new Error('Incomplete response');

          break;
        }

        wireBytes += value.byteLength;
        if (wireBytes > MAX_WIRE_BYTES) throw new Error('Response too large');

        const result = parser.execute(Buffer.from(value));
        if (result instanceof Error) throw new Error('Malformed response');
      }

      const bytes = new Uint8Array(bodyBytes);
      let offset = 0;

      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }

      // Only the content type is needed by createRelay. Location and Set-Cookie never escape.
      const safeHeaders = new Headers();

      if (headers.has('content-type'))
        safeHeaders.set('content-type', headers.get('content-type')!);

      return new Response(status === 204 || status === 304 ? null : bytes, {
        status,
        headers: safeHeaders,
      });
    } finally {
      request.signal.removeEventListener('abort', abort);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
      writer.releaseLock();
      await socket.close().catch(() => {});
    }
  };
}
