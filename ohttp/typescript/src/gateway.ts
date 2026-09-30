import { KeyConfig, OHTTPServer, type KeyConfigWithPrivate } from 'ohttp-ts';
import {
  HttpError,
  INNER_TARGET,
  KEYS_TYPE,
  MAX_ENVELOPE_BYTES,
  MAX_MESSAGE_BYTES,
  REQUEST_TYPE,
  mediaType,
  readLimited,
  response,
  upstreamUrl,
  type Fetcher,
} from './http.js';

export interface GatewayOptions {
  keys: readonly KeyConfigWithPrivate[];

  /** Exact collector /v1/events URL; decrypted requests cannot choose another target. */
  collectorUrl: string;
  allowHttp?: boolean;
  timeoutMs?: number;
  fetch?: Fetcher;
}

/** Decrypts and routes one narrowly defined report operation, never arbitrary HTTP. */
export function createGateway(options: GatewayOptions): Fetcher {
  const target = upstreamUrl(options.collectorUrl, options.allowHttp);
  const server = new OHTTPServer(options.keys);
  const publicKeys = KeyConfig.serializeMultiple(options.keys);
  const send = options.fetch ?? fetch;

  return async (request) => {
    const url = new URL(request.url);

    if (url.search) return response(null, 404);
    if (url.pathname === '/healthz' && request.method === 'GET')
      return response('ok', 200, 'text/plain');
    if (url.pathname === '/ohttp-keys' && request.method === 'GET')
      return response(publicKeys, 200, KEYS_TYPE);

    if (url.pathname !== '/ohttp') return response(null, 404);
    if (request.method !== 'POST') return response(null, 405);

    if (mediaType(request.headers) !== REQUEST_TYPE || request.headers.has('content-encoding'))
      return response(null, 415);

    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(options.timeoutMs ?? 10_000),
    ]);
    let decoded: Awaited<ReturnType<OHTTPServer['decapsulateRequest']>>;

    try {
      const bytes = await readLimited(request, MAX_MESSAGE_BYTES, signal);

      decoded = await server.decapsulateRequest(
        new Request('https://gateway.invalid/ohttp', {
          method: 'POST',
          headers: { 'content-type': REQUEST_TYPE },
          body: bytes,
        }),
      );
    } catch (error) {
      // Do not disclose key IDs, crypto exceptions, or malformed BHTTP details.
      return response(null, error instanceof HttpError ? error.status : 400);
    }

    const innerResponse = async (): Promise<Response> => {
      const inner = decoded.request;

      if (inner.url !== INNER_TARGET || inner.method !== 'POST')
        return new Response(null, { status: 400 });

      if (
        mediaType(inner.headers) !== 'application/json' ||
        [...inner.headers.keys()].some((header) => header !== 'content-type')
      ) {
        return new Response(null, { status: 400 });
      }

      let envelope: unknown;

      try {
        envelope = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            await readLimited(inner, MAX_ENVELOPE_BYTES, signal),
          ),
        );

        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
          return new Response(null, { status: 400 });
      } catch (error) {
        return new Response(null, { status: error instanceof HttpError ? error.status : 400 });
      }

      try {
        // No external metadata is trusted. The encrypted transport deliberately reports unknown country.
        const collector = await send(
          new Request(target, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ country: 'ZZ', envelope }),
            redirect: 'error',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            signal,
          }),
        );

        // Collector diagnostics never become an acceptance oracle for clients or relays.
        void collector.body?.cancel().catch(() => {});

        return new Response(null, { status: collector.status === 200 ? 200 : 503 });
      } catch {
        return new Response(null, { status: 503 });
      }
    };

    try {
      const encrypted = await decoded.context.encapsulateResponse(await innerResponse());

      // Only protocol headers leave the gateway; inner errors remain encrypted.
      return response(await encrypted.arrayBuffer(), 200, 'message/ohttp-res');
    } catch {
      return response(null, 400);
    }
  };
}
