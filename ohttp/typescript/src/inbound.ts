import type { KeyConfigWithPrivate } from 'ohttp-ts';
import { importKeys, type StoredKey } from './crypto.js';
import { createGateway } from './gateway.js';
import type { Fetcher } from './http.js';

export interface InboundOptions {
  keys: readonly KeyConfigWithPrivate[];
  timeoutMs?: number;
}

/**
 * Receive bounded OHTTP reports and discard them after decoding.
 * The internal collector adapter is an in-memory sink: it neither reads nor
 * stores the report and never makes a network request or verifies report tokens.
 */
export function createInbound(options: InboundOptions): Fetcher {
  return createGateway({
    ...options,
    collectorUrl: 'https://discard.fray.invalid/v1/events',
    fetch: async () => new Response(null, { status: 200 }),
  });
}

/** Heroku config persists across dyno restarts; its filesystem does not. */
export async function loadInboundKeys(value: string | undefined): Promise<KeyConfigWithPrivate[]> {
  if (!value) throw new Error('OHTTP_KEYS_JSON is required');

  try {
    const keys: unknown = JSON.parse(value);

    if (
      !Array.isArray(keys) ||
      keys.length === 0 ||
      keys.length > 16 ||
      keys.some(
        (key) =>
          !key ||
          typeof key !== 'object' ||
          !Number.isInteger(key.keyId) ||
          key.keyId < 0 ||
          key.keyId > 255 ||
          typeof key.publicKey !== 'string' ||
          typeof key.privateKey !== 'string',
      ) ||
      new Set(keys.map((key) => key.keyId)).size !== keys.length
    ) {
      throw new Error('Invalid key configuration');
    }

    return await importKeys(keys as StoredKey[]);
  } catch {
    // JSON/crypto diagnostics can contain configuration values. Never log them.
    throw new Error('OHTTP_KEYS_JSON must contain valid gateway private keys with distinct IDs');
  }
}
