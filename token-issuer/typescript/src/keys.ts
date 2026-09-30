import {
  createPrivateKey,
  createPublicKey,
  generateKeyPair,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { epochIdFor, isValidKid, previousEpochIdFor } from './epoch.js';

export const JWKS_ALG = 'RSABSSA-SHA384-PSS-Deterministic';

export interface PublishedJwk {
  kty: 'RSA';
  n: string;
  e: string;
  kid: string;
  use: 'sig';
  alg: typeof JWKS_ALG;
}

interface EpochKeys {
  kid: string;
  signingKey: KeyObject;
  verificationKey: KeyObject;
  n: bigint;
  kLen: number;
}

const generateRsa = promisify(generateKeyPair);

/** One persisted private key per UTC month. Its public half is always derived. */
export class KeyManager {
  private readonly cache = new Map<string, EpochKeys>();
  private readonly pending = new Map<string, Promise<EpochKeys>>();

  constructor(private readonly keysDir: string) {}

  private path(kid: string): string {
    if (!isValidKid(kid)) {
      throw new Error('invalid epoch key id');
    }

    return join(this.keysDir, `${kid}.key.pem`);
  }

  async currentKid(now: Date = new Date()): Promise<string> {
    const kid = epochIdFor(now);
    await this.epochKeys(kid);

    return kid;
  }

  async epochKeys(kid: string): Promise<EpochKeys> {
    if (this.cache.has(kid)) {
      return this.cache.get(kid)!;
    }

    if (!this.pending.has(kid)) {
      const operation = this.ensure(kid)
        .then((key) => {
          this.cache.set(kid, key);
          return key;
        })
        .finally(() => {
          this.pending.delete(kid);
        });
      this.pending.set(kid, operation);
    }

    return this.pending.get(kid)!;
  }

  private async load(kid: string): Promise<EpochKeys | null> {
    let pem: Buffer;
    try {
      pem = await readFile(this.path(kid));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }

      throw error; // Corrupt or unreadable keys must never be silently replaced.
    }

    const signingKey = createPrivateKey(pem);
    const verificationKey = createPublicKey(signingKey);
    const publicJwk = verificationKey.export({ format: 'jwk' });

    if (
      signingKey.asymmetricKeyType !== 'rsa' ||
      !publicJwk.n ||
      !publicJwk.e ||
      (signingKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    ) {
      throw new Error('expected RSA key of at least 2048 bits');
    }

    const nBytes = Buffer.from(publicJwk.n, 'base64url');

    return {
      kid,
      signingKey,
      verificationKey,
      n: BigInt('0x' + nBytes.toString('hex')),
      kLen: nBytes.length,
    };
  }

  private async ensure(kid: string): Promise<EpochKeys> {
    const loaded = await this.load(kid);
    if (loaded) {
      return loaded;
    }

    await mkdir(this.keysDir, { recursive: true, mode: 0o700 });
    const { privateKey } = await generateRsa('rsa', { modulusLength: 2048, publicExponent: 65537 });
    const path = this.path(kid);
    const temporary = `${path}.tmp-${randomBytes(12).toString('hex')}`;
    const file = await open(temporary, 'wx', 0o600);

    try {
      try {
        await file.writeFile(privateKey.export({ type: 'pkcs8', format: 'pem' }));
        await file.sync();
      } finally {
        await file.close();
      }

      // Publish a completed file without replacing an epoch key another writer won.
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
    } finally {
      await unlink(temporary);
    }

    const winner = await this.load(kid);
    if (!winner) {
      throw new Error('epoch key publication failed');
    }

    return winner;
  }

  async jwks(now: Date = new Date()): Promise<{ keys: PublishedJwk[] }> {
    const current = await this.currentKid(now);
    const keys: PublishedJwk[] = [];

    for (const kid of [current, previousEpochIdFor(now)]) {
      const key = this.cache.get(kid) ?? (await this.load(kid));
      if (!key) {
        continue;
      }

      const { n, e } = key.verificationKey.export({ format: 'jwk' });
      keys.push({ kty: 'RSA', n: n!, e: e!, kid, use: 'sig', alg: JWKS_ALG });
    }

    return { keys };
  }
}
