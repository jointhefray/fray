import { assertPublicWatchlist, watchlistExpired, type Watchlist } from './watchlist.js';

export const UPSTREAM_URL = 'https://adpocalypse.net/fray/watchlist.json';
export const WATCHLIST_PATH = '/v1/watchlist.json';
export const SNAPSHOT_KEY = 'watchlist:v1';
export const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CACHE_SECONDS = 300;

export interface Env {
  REGISTRY: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<void>;
  };
}

interface Options {
  fetch?: typeof fetch;
  now?: () => number;
}

/** Accept only the public registry shape; never publish accidental extra source fields. */
export function parseSnapshot(body: string): Watchlist {
  if (
    body.length > MAX_SNAPSHOT_BYTES ||
    new TextEncoder().encode(body).length > MAX_SNAPSHOT_BYTES
  ) {
    throw new Error('Registry snapshot exceeds size limit');
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error('Invalid public registry snapshot');
  }
  assertPublicWatchlist(value);
  if (Date.parse(value.published) >= Date.parse(value.expires)) {
    throw new Error('Invalid public registry snapshot');
  }
  return value;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Registry refresh timed out'));
    if (signal.aborted) {
      abort();
      void operation.catch(() => {});
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

async function readBounded(response: Response, signal: AbortSignal): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_SNAPSHOT_BYTES)) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Registry snapshot exceeds size limit');
  }
  if (!response.body) throw new Error('Empty registry response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SNAPSHOT_BYTES) throw new Error('Registry snapshot exceeds size limit');
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Used only by scheduled refreshes and the operator's seed command, never by public GET. */
export async function downloadSnapshot(options: Options = {}): Promise<string> {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await abortable(
      fetcher(UPSTREAM_URL, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: controller.signal,
      }),
      controller.signal,
    );
    if (
      response.status !== 200 ||
      response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !==
        'application/json'
    ) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Registry source unavailable');
    }
    const body = await readBounded(response, controller.signal);
    const document = parseSnapshot(body);
    if (watchlistExpired(document, now())) throw new Error('Registry source has expired');
    // Re-serialize the validated object: overwritten duplicate JSON keys must not
    // smuggle unvalidated fields into the public bytes.
    return JSON.stringify(document);
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshSnapshot(env: Env, options: Options = {}): Promise<void> {
  const body = await downloadSnapshot(options);
  const next = parseSnapshot(body);
  const previousBody = await env.REGISTRY.get(SNAPSHOT_KEY);
  if (previousBody !== null) {
    let previous: Watchlist | undefined;
    try {
      previous = parseSnapshot(previousBody);
    } catch {
      /* Replace corrupt stored data. */
    }
    if (previous && next.version < previous.version) throw new Error('Registry revision regressed');
  }
  // Recheck after KV I/O, preserving source values without extending their expiry.
  if (watchlistExpired(next, (options.now ?? Date.now)()))
    throw new Error('Registry source has expired');
  await env.REGISTRY.put(SNAPSHOT_KEY, body);
}

function response(request: Request, status: number, body: string, cache = 'no-store'): Response {
  return new Response(request.method === 'HEAD' || status === 204 ? null : body, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cache,
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'x-content-type-options': 'nosniff',
    },
  });
}

export function createRegistry(options: Options = {}) {
  const now = options.now ?? Date.now;
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== WATCHLIST_PATH && url.pathname !== '/healthz') {
        return response(request, 404, '{"error":"not found"}');
      }
      if (request.method === 'OPTIONS') return response(request, 204, '');
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const result = response(request, 405, '{"error":"method not allowed"}');
        result.headers.set('allow', 'GET, HEAD, OPTIONS');
        return result;
      }
      if (url.pathname === '/healthz') return response(request, 200, '{"ok":true}');
      try {
        const body = await env.REGISTRY.get(SNAPSHOT_KEY);
        if (body === null) throw new Error('No registry snapshot');
        const document = parseSnapshot(body);
        const currentTime = now();
        if (!Number.isFinite(currentTime) || watchlistExpired(document, currentTime)) {
          throw new Error('Registry snapshot expired');
        }
        const seconds = Math.max(
          0,
          Math.min(
            MAX_CACHE_SECONDS,
            Math.floor((Date.parse(document.expires) - currentTime) / 1000),
          ),
        );
        return response(
          request,
          200,
          JSON.stringify(document),
          `public, max-age=${seconds}, must-revalidate`,
        );
      } catch {
        return response(request, 503, '{"error":"registry unavailable"}');
      }
    },
    async scheduled(_controller: unknown, env: Env): Promise<void> {
      await refreshSnapshot(env, options);
    },
  };
}

export default createRegistry();
