import {
  createHash,
  createPrivateKey,
  generateKeyPair,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { epochIdFor, isValidEpoch, previousEpochIdFor } from './epoch.js';
import {
  SUITE,
  TOKEN_META_VALUES,
  bigIntToBytes,
  bytesToBigInt,
  type TokenMeta,
} from './rsabssa.js';

export const JWKS_ALG = SUITE;
export const MODULUS_BITS = 2048;
const PUBLIC_EXPONENT = 65537n;
// Distinct file names: keys from other schemes or versions are never loaded.
const KEY_FILE_SUFFIX = '.rsabssa.key.pem';
const JWKS_FILE_SUFFIX = '.rsabssa.jwks.json';

export interface PublishedJwk {
  kty: 'RSA';
  n: string;
  e: string;
  kid: string;
  use: 'sig';
  alg: typeof JWKS_ALG;
}

export interface EpochSigningKey {
  kid: string;
  meta: TokenMeta;
  n: bigint;
  signingKey: KeyObject;
  jwk: PublishedJwk;
}

/** One epoch's four keys; `keys[n]` signs tokens whose metadata value is n. */
export interface EpochKeySet {
  epoch: string;
  kLen: number;
  keys: readonly EpochSigningKey[];
}

/** The current epoch has no keys on disk. Generate them ahead of time with the keygen command. */
export class KeyUnavailableError extends Error {
  constructor(public readonly epoch: string) {
    super(`no ${epoch} keys; generate them with the keygen command before serving`);
    this.name = 'KeyUnavailableError';
  }
}

function checkEpoch(epoch: string): void {
  if (!isValidEpoch(epoch)) {
    throw new Error('invalid epoch id');
  }
}

/** The key ID of an epoch's key for one metadata value: "ep-YYYY-MM.N". */
export function keyId(epoch: string, meta: TokenMeta): string {
  checkEpoch(epoch);
  return `${epoch}.${meta}`;
}

export function epochKeyPath(keysDir: string, epoch: string, meta: TokenMeta): string {
  return join(keysDir, `${keyId(epoch, meta)}${KEY_FILE_SUFFIX}`);
}

/** The public JWKS fragment that the keygen command writes for each epoch. */
export function epochJwksPath(keysDir: string, epoch: string): string {
  checkEpoch(epoch);
  return join(keysDir, `${epoch}${JWKS_FILE_SUFFIX}`);
}

async function loadKey(
  keysDir: string,
  epoch: string,
  meta: TokenMeta,
): Promise<EpochSigningKey | null> {
  let pem: Buffer;
  try {
    pem = await readFile(epochKeyPath(keysDir, epoch, meta));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error; // Corrupt or unreadable keys must never be silently replaced.
  }

  const signingKey = createPrivateKey(pem);
  const jwk = signingKey.export({ format: 'jwk' });
  if (
    signingKey.asymmetricKeyType !== 'rsa' ||
    signingKey.asymmetricKeyDetails?.modulusLength !== MODULUS_BITS ||
    !jwk.n ||
    !jwk.e ||
    bytesToBigInt(Buffer.from(jwk.e, 'base64url')) !== PUBLIC_EXPONENT
  ) {
    throw new Error(`expected an RSA-${MODULUS_BITS} key with e = 65537`);
  }

  const kid = keyId(epoch, meta);
  return {
    kid,
    meta,
    n: bytesToBigInt(Buffer.from(jwk.n, 'base64url')),
    signingKey,
    jwk: { kty: 'RSA', n: jwk.n, e: jwk.e, kid, use: 'sig', alg: JWKS_ALG },
  };
}

/**
 * Load an epoch's four keys. Null when none exists; an incomplete set, a duplicated key or
 * any invalid key throws, so the issuer fails closed instead of serving part of an epoch.
 */
export async function loadEpochKeys(keysDir: string, epoch: string): Promise<EpochKeySet | null> {
  const loaded = await Promise.all(TOKEN_META_VALUES.map((meta) => loadKey(keysDir, epoch, meta)));
  const keys = loaded.filter((key): key is EpochSigningKey => key !== null);
  if (keys.length === 0) {
    return null;
  }

  if (keys.length !== TOKEN_META_VALUES.length) {
    throw new Error(`incomplete ${epoch} key set: ${keys.length} of 4 keys`);
  }

  if (new Set(keys.map((key) => key.n)).size !== keys.length) {
    throw new Error(`${epoch} reuses a key for two metadata values`);
  }

  return { epoch, kLen: MODULUS_BITS / 8, keys };
}

/** Loads persisted epoch keys. It never generates one: see generateEpochKeys. */
export class KeyManager {
  private readonly cache = new Map<string, EpochKeySet>();
  private readonly pending = new Map<string, Promise<EpochKeySet | null>>();

  constructor(private readonly keysDir: string) {}

  /** A loaded key set, or null when the epoch has no keys (missing sets are not cached). */
  async get(epoch: string): Promise<EpochKeySet | null> {
    const cached = this.cache.get(epoch);
    if (cached) {
      return cached;
    }

    if (!this.pending.has(epoch)) {
      const operation = loadEpochKeys(this.keysDir, epoch)
        .then((set) => {
          if (set) {
            this.cache.set(epoch, set);
          }
          return set;
        })
        .finally(() => {
          this.pending.delete(epoch);
        });
      this.pending.set(epoch, operation);
    }

    return this.pending.get(epoch)!;
  }

  async current(now: Date = new Date()): Promise<EpochKeySet> {
    const epoch = epochIdFor(now);
    const set = await this.get(epoch);
    if (!set) {
      throw new KeyUnavailableError(epoch);
    }

    return set;
  }

  /** The current and previous UTC months' keys that exist, four each; the same for everyone. */
  async jwks(now: Date = new Date()): Promise<{ keys: PublishedJwk[] }> {
    const keys: PublishedJwk[] = [];
    for (const epoch of [epochIdFor(now), previousEpochIdFor(now)]) {
      const set = await this.get(epoch);
      for (const key of set?.keys ?? []) {
        keys.push({ ...key.jwk });
      }
    }

    return { keys };
  }
}

/**
 * Persist one key as mode-0600 PKCS#8 with an atomic no-replace hard link. Returns false,
 * leaving the file untouched, if a key already holds that epoch and value.
 */
export async function writeEpochKey(
  keysDir: string,
  epoch: string,
  meta: TokenMeta,
  privateKey: KeyObject,
): Promise<boolean> {
  const path = epochKeyPath(keysDir, epoch, meta);
  await mkdir(keysDir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomBytes(12).toString('hex')}`;
  const file = await open(temporary, 'wx', 0o600);
  let created = true;

  try {
    try {
      await file.writeFile(privateKey.export({ type: 'pkcs8', format: 'pem' }));
      await file.sync();
    } finally {
      await file.close();
    }

    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      created = false;
    }
  } finally {
    await unlink(temporary);
  }

  // Re-read the published file through the same checks the issuer applies.
  if (!(await loadKey(keysDir, epoch, meta))) {
    throw new Error('epoch key publication failed');
  }

  return created;
}

export interface GeneratedKeys {
  epoch: string;
  /** Key IDs written by this call; existing keys are kept and not listed. */
  created: string[];
  /** The public JWKS fragment for the epoch, for publishing or auditing outside the issuer. */
  jwksPath: string;
  /** SHA-256 of each public modulus by key ID, for comparing replicas. Public information. */
  modulusSha256: Record<string, string>;
}

const newRsaKey = promisify(generateKeyPair);

/**
 * Generate any of an epoch's four RSA-2048 keys (e = 65537) that do not exist yet, then write
 * the epoch's public JWKS fragment. Uses OpenSSL off the event loop: typically 100 ms or so
 * per key. Existing keys are never replaced.
 */
export async function generateEpochKeys(keysDir: string, epoch: string): Promise<GeneratedKeys> {
  const created: string[] = [];
  for (const meta of TOKEN_META_VALUES) {
    if (!(await loadKey(keysDir, epoch, meta))) {
      const { privateKey } = await newRsaKey('rsa', {
        modulusLength: MODULUS_BITS,
        publicExponent: Number(PUBLIC_EXPONENT),
      });
      if (await writeEpochKey(keysDir, epoch, meta, privateKey)) {
        created.push(keyId(epoch, meta));
      }
    }
  }

  const set = await loadEpochKeys(keysDir, epoch);
  if (!set) {
    throw new Error('epoch key publication failed');
  }

  // The public halves, read from the key files; rewriting them is idempotent.
  const jwksPath = epochJwksPath(keysDir, epoch);
  const temporary = `${jwksPath}.tmp-${randomBytes(12).toString('hex')}`;
  const file = await open(temporary, 'wx', 0o644);
  try {
    await file.writeFile(JSON.stringify({ keys: set.keys.map((key) => key.jwk) }, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, jwksPath);

  return {
    epoch,
    created,
    jwksPath,
    modulusSha256: Object.fromEntries(
      set.keys.map((key) => [
        key.kid,
        createHash('sha256').update(bigIntToBytes(key.n, set.kLen)).digest('hex'),
      ]),
    ),
  };
}
