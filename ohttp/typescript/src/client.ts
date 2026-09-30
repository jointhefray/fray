import { KeyConfig, OHTTPClient } from 'ohttp-ts';
import { cipherSuite } from './crypto.js';
import {
  INNER_TARGET,
  KEYS_TYPE,
  MAX_ENVELOPE_BYTES,
  MAX_KEY_BYTES,
  MAX_MESSAGE_BYTES,
  RESPONSE_TYPE,
  mediaType,
  readLimited,
  upstreamUrl,
  type Fetcher,
} from './http.js';

export interface ClientOptions {
  /** Relay /ohttp endpoint. Only the relay receives network requests. */
  relayUrl: string;
  allowHttp?: boolean;
  timeoutMs?: number;
  fetch?: Fetcher;
}

/** RFC 9458 transport; consent, minimisation and one-use tokens belong to the caller. */
export class FrayOhttpClient {
  private readonly client: OHTTPClient;

  private constructor(publicConfig: Uint8Array) {
    const suite = cipherSuite();

    this.client = new OHTTPClient(
      suite,
      KeyConfig.select(suite, KeyConfig.parseMultiple(publicConfig)),
    );
  }

  static create(publicConfig: Uint8Array): FrayOhttpClient {
    if (!publicConfig.length || publicConfig.length > MAX_KEY_BYTES)
      throw new Error('Invalid OHTTP keys');

    return new FrayOhttpClient(publicConfig);
  }

  /** Key delivery must be authenticated by the integration (see README: pinning). */
  static async discover(options: ClientOptions): Promise<FrayOhttpClient> {
    const relay = upstreamUrl(options.relayUrl, options.allowHttp);
    const signal = AbortSignal.timeout(options.timeoutMs ?? 10_000);

    const result = await (options.fetch ?? fetch)(
      new Request(new URL('/ohttp-keys', relay), {
        headers: { accept: KEYS_TYPE },
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal,
      }),
    );

    if (result.status !== 200 || mediaType(result.headers) !== KEYS_TYPE)
      throw new Error('OHTTP keys unavailable');

    return FrayOhttpClient.create(await readLimited(result, MAX_KEY_BYTES, signal));
  }

  async send(envelope: unknown, options: ClientOptions): Promise<Response> {
    const relay = upstreamUrl(options.relayUrl, options.allowHttp);
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));

    if (!bytes.length || bytes.length > MAX_ENVELOPE_BYTES)
      throw new Error('Report exceeds size limit');

    const signal = AbortSignal.timeout(options.timeoutMs ?? 10_000);

    const { init, context } = await this.client.encapsulateRequest(
      new Request(INNER_TARGET, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: bytes,
      }),
    );

    const outer = await (options.fetch ?? fetch)(
      new Request(relay, {
        ...init,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        signal,
      }),
    );

    if (outer.status !== 200 || mediaType(outer.headers) !== RESPONSE_TYPE) {
      void outer.body?.cancel().catch(() => {});
      throw new Error('OHTTP relay rejected the report');
    }

    const encrypted = await readLimited(outer, MAX_MESSAGE_BYTES, signal);

    return context.decapsulateResponse(
      new Response(encrypted, { headers: { 'content-type': RESPONSE_TYPE } }),
    );
  }
}
