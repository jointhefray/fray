import {
  HttpError,
  KEYS_TYPE,
  MAX_KEY_BYTES,
  MAX_MESSAGE_BYTES,
  REQUEST_TYPE,
  RESPONSE_TYPE,
  mediaType,
  preflight,
  readLimited,
  response,
  upstreamUrl,
  type Fetcher,
} from './http.js';

export interface RelayOptions {
  gatewayUrl: string;
  keysUrl?: string;
  allowHttp?: boolean;
  timeoutMs?: number;
  fetch?: Fetcher;
}

/** The relay handles ciphertext only. It has neither keys nor a JSON parser. */
export function createRelay(options: RelayOptions): Fetcher {
  const gateway = upstreamUrl(options.gatewayUrl, options.allowHttp);
  const keys = upstreamUrl(
    options.keysUrl ?? new URL('/ohttp-keys', gateway).href,
    options.allowHttp,
  );

  if (gateway.origin !== keys.origin) throw new Error('Gateway and keys must share an origin');

  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return async (request) => {
    const url = new URL(request.url);

    if (url.search) return response(null, 404);
    if (url.pathname === '/healthz' && request.method === 'GET')
      return response('ok', 200, 'text/plain');

    const isKeys = url.pathname === '/ohttp-keys';

    if (!isKeys && url.pathname !== '/ohttp') return response(null, 404);
    if (request.method === 'OPTIONS') return preflight();
    if (request.method !== (isKeys ? 'GET' : 'POST')) return response(null, 405);

    if (
      !isKeys &&
      (mediaType(request.headers) !== REQUEST_TYPE || request.headers.has('content-encoding'))
    ) {
      return response(null, 415);
    }

    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
    let body: Uint8Array<ArrayBuffer> | undefined;

    try {
      if (!isKeys) {
        body = await readLimited(request, MAX_MESSAGE_BYTES, signal);

        if (body.length === 0) return response(null, 400);
      }
    } catch (error) {
      return response(null, error instanceof HttpError ? error.status : 408);
    }

    try {
      // Construct from scratch: cookies, authorization, forwarding and tracing headers are discarded.
      const upstream = await send(
        new Request(isKeys ? keys : gateway, {
          method: isKeys ? 'GET' : 'POST',
          headers: isKeys
            ? { accept: KEYS_TYPE }
            : { 'content-type': REQUEST_TYPE, accept: RESPONSE_TYPE },
          body,
          // Workers supports manual redirects; the status allowlist below rejects every 3xx.
          redirect: 'manual',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal,
        }),
      );

      if (upstream.status !== 200) {
        void upstream.body?.cancel().catch(() => {});
        const status = [400, 401, 403, 413, 415, 429, 500, 502, 503, 504].includes(upstream.status)
          ? upstream.status
          : 502;

        return response(null, status);
      }

      const expected = isKeys ? KEYS_TYPE : RESPONSE_TYPE;

      if (mediaType(upstream.headers) !== expected || upstream.headers.has('content-encoding')) {
        void upstream.body?.cancel().catch(() => {});
        return response(null, 502);
      }

      const result = await readLimited(
        upstream,
        isKeys ? MAX_KEY_BYTES : MAX_MESSAGE_BYTES,
        signal,
      );

      return result.length ? response(result, 200, expected) : response(null, 502);
    } catch {
      return response(null, signal.aborted ? 504 : 502);
    }
  };
}
