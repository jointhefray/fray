import { readFile } from 'node:fs/promises';
import { KeyConfig, OHTTPServer } from 'ohttp-ts';
import { cipherSuite } from '../src/crypto.js';
import type { Fetcher } from '../src/http.js';

/** Synthetic, test-only secret in the accepted format. */
export const RELAY_SECRET = 'test-only-relay-secret-'.padEnd(44, 'A');

export const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
};

export interface Vectors {
  country: { input: string | null; expected: string }[];
  device: { name: string; platform: string | null; userAgent: string | null; expected: string }[];
}

export const vectors = JSON.parse(
  await readFile(new URL('../../test-vectors/relay-metadata.json', import.meta.url), 'utf8'),
) as Vectors;

/** Test-only gateway keys, generated for each run. */
export const keys = [await KeyConfig.generate(cipherSuite(), 1)];
export const publicKeys = KeyConfig.serializeMultiple(keys);

/** A JSON object whose serialized UTF-8 form is exactly `bytes` long. */
export function envelopeOfSize(bytes: number): { p: string } {
  return { p: 'x'.repeat(bytes - '{"p":""}'.length) };
}

/**
 * A test stand-in for the separately operated receiving gateway, built directly on
 * ohttp-ts. It is not a gateway implementation: it decapsulates with the test keys,
 * hands the decrypted inner request and the relay's outer request to `respond`, and
 * encrypts whatever response the test returns (an empty 200 by default).
 */
export function standInGateway(
  respond: (inner: Request, outer: Request) => Response | Promise<Response> = () =>
    new Response(null, { status: 200 }),
): Fetcher {
  const server = new OHTTPServer(keys);

  return async (outer) => {
    const { request, context } = await server.decapsulateRequest(outer.clone());
    return context.encapsulateResponse(await respond(request, outer));
  };
}
