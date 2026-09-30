import { constants, privateDecrypt, publicEncrypt, timingSafeEqual } from 'node:crypto';
import { KeyManager, type PublishedJwk } from './keys.js';
import { DailyQuota, type QuotaStore } from './quota.js';

/** Return a stable quota subject after checking the partner's existing auth. */
export type ValidateUser<Context> = (context: Context) => string | null | Promise<string | null>;

export interface IssuanceEvent {
  ts: string;
  event: 'issue';
  client: string;
  count: number;
  epoch: string;
}

export interface IssueResponse {
  kid: string;
  signatures: string[];
}

export interface IssuerOptions<Context> {
  keysDir: string;
  validateUser: ValidateUser<Context>;
  quota?: QuotaStore;
  maxBatch?: number;
  clock?: () => Date;
  /** Receives only protocol audit fields, never credentials or token values. */
  onIssue?: (event: IssuanceEvent) => void | Promise<void>;
}

export class IssuanceError extends Error {
  constructor(
    public readonly status: 400 | 401 | 429,
    public readonly code: string,
  ) {
    super(code);
    this.name = 'IssuanceError';
  }
}

/** Authenticate, validate, reserve quota, then blind-sign an entire batch. */
export class PrivacyTokenIssuer<Context> {
  private readonly keys: KeyManager;
  private readonly quota: QuotaStore;
  private readonly maxBatch: number;
  private readonly clock: () => Date;

  constructor(private readonly options: IssuerOptions<Context>) {
    if (typeof options.validateUser !== 'function') {
      throw new Error('validateUser is required');
    }

    this.maxBatch = options.maxBatch ?? 64;
    if (!Number.isSafeInteger(this.maxBatch) || this.maxBatch < 1 || this.maxBatch > 64) {
      throw new Error('maxBatch must be an integer from 1 to 64');
    }

    this.keys = new KeyManager(options.keysDir);
    this.quota = options.quota ?? new DailyQuota(64);
    this.clock = options.clock ?? (() => new Date());
  }

  /** Warm the current epoch key before accepting traffic. */
  async initialize(): Promise<void> {
    await this.keys.currentKid(this.clock());
  }

  /** Exactly the current and, if present, previous UTC month public keys. */
  publishKeys(): Promise<{ keys: PublishedJwk[] }> {
    return this.keys.jwks(this.clock());
  }

  async issue(context: Context, body: unknown): Promise<IssueResponse> {
    const client = await this.options.validateUser(context);
    if (typeof client !== 'string' || !client.trim()) {
      throw new IssuanceError(401, 'unauthorized');
    }

    const blinded =
      body && typeof body === 'object' && 'blinded' in body ? body.blinded : undefined;
    if (!Array.isArray(blinded) || blinded.length < 1 || blinded.length > this.maxBatch) {
      throw new IssuanceError(400, 'bad_request');
    }

    const now = this.clock();
    const kid = await this.keys.currentKid(now);
    const key = await this.keys.epochKeys(kid);
    const encodedLength = 4 * Math.ceil(key.kLen / 3);

    const messages = blinded.map((value: unknown) => {
      if (
        typeof value !== 'string' ||
        value.length !== encodedLength ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
      ) {
        throw new IssuanceError(400, 'bad_blinded');
      }

      const bytes = Buffer.from(value, 'base64');
      if (bytes.length !== key.kLen || bytes.toString('base64') !== value) {
        throw new IssuanceError(400, 'bad_blinded');
      }

      const valueInt = BigInt('0x' + bytes.toString('hex'));
      if (valueInt <= 0n || valueInt >= key.n) {
        throw new IssuanceError(400, 'bad_blinded');
      }

      return bytes;
    });

    // Validate everything first; the store must reserve the whole batch atomically.
    if (!(await this.quota.take(client, messages.length, now))) {
      throw new IssuanceError(429, 'quota_exceeded');
    }

    const signatures = messages.map((message) => {
      // RFC 9474 §4.2: raw RSA private operation, then the public self-check.
      // PSS encoding stays client-side. Node delegates the private operation to OpenSSL.
      const signature = privateDecrypt(
        { key: key.signingKey, padding: constants.RSA_NO_PADDING },
        message,
      );
      const checked = publicEncrypt(
        { key: key.verificationKey, padding: constants.RSA_NO_PADDING },
        signature,
      );
      if (!timingSafeEqual(checked, message)) {
        throw new Error('blind signing self-check failed');
      }

      return signature.toString('base64');
    });

    // Failed signing/audit does not refund quota: retries cannot exceed the daily cap.
    const event: IssuanceEvent = {
      ts: now.toISOString(),
      event: 'issue',
      client,
      count: signatures.length,
      epoch: kid,
    };

    if (this.options.onIssue) {
      await this.options.onIssue(event);
    } else {
      process.stdout.write(JSON.stringify(event) + '\n');
    }

    return { kid, signatures };
  }
}
