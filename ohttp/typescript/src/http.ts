/** Limits include the encrypted BHTTP framing, not only the report JSON. */
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_ENVELOPE_BYTES = 8 * 1024 - 128;
export const MAX_KEY_BYTES = 4096;

export const REQUEST_TYPE = 'message/ohttp-req';
export const RESPONSE_TYPE = 'message/ohttp-res';
export const KEYS_TYPE = 'application/ohttp-keys';
export const INNER_TARGET = 'https://collector.fray.invalid/submit';

export type Fetcher = (request: Request) => Promise<Response>;

export class HttpError extends Error {
  constructor(readonly status: number) {
    super('Request rejected');
  }
}

export function mediaType(headers: Headers): string {
  return (headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
}

/** Explicit configuration is the entire upstream allowlist. Never use a client URL. */
export function upstreamUrl(value: string, allowHttp = false): URL {
  const url = new URL(value);

  if (
    (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    throw new Error('Upstream must be a fixed HTTPS URL without credentials, query, or fragment');
  }

  return url;
}

export async function readLimited(
  message: Request | Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const length = message.headers.get('content-length');

  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    throw new HttpError(413);
  }

  if (!message.body) return new Uint8Array();

  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  const abort = () => {
    void reader.cancel().catch(() => {});
  };

  signal.addEventListener('abort', abort, { once: true });

  try {
    signal.throwIfAborted();

    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;

      size += value.byteLength;
      if (size > maxBytes) throw new HttpError(413);

      chunks.push(value);
    }

    const bytes = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return bytes;
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function response(body: BodyInit | null, status: number, contentType?: string): Response {
  const headers = new Headers({
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
  });

  if (contentType) headers.set('content-type', contentType);

  return new Response(body, { status, headers });
}

export function preflight(): Response {
  const result = response(null, 204);

  result.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  result.headers.set('access-control-allow-headers', 'Content-Type');
  result.headers.set('access-control-max-age', '600');

  return result;
}
