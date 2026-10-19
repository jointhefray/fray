import { KeyManager, KeyUnavailableError, type PublishedJwk } from './keys.js';
import { blindSign, isTokenMeta, type TokenMeta } from './rsabssa.js';
import { DailyQuota, type QuotaStore } from './quota.js';

/** Return a stable quota subject after checking the partner's existing auth. */
export type ValidateUser<Context> = (context: Context) => string | null | Promise<string | null>;

/**
 * Return the account's current metadata value, an integer from 0 to 3, for the subject that
 * validateUser returned. Each value has its own epoch key. Values are issuer-defined; the
 * protocol does not publish their meanings.
 */
export type MetaFor = (subject: string) => number | Promise<number>;

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

export interface MetaResponse {
  meta: TokenMeta;
}

export interface IssuerOptions<Context> {
  keysDir: string;
  validateUser: ValidateUser<Context>;
  metaFor: MetaFor;
  quota?: QuotaStore;
  maxBatch?: number;
  clock?: () => Date;
  /** Receives only protocol audit fields, never credentials or token values. */
  onIssue?: (event: IssuanceEvent) => void | Promise<void>;
}

export class IssuanceError extends Error {
  constructor(
    public readonly status: 400 | 401 | 409 | 429 | 503,
    public readonly code: string,
  ) {
    super(code);
    this.name = 'IssuanceError';
  }
}

/** Authenticate, check the metadata value, reserve quota, then blind-sign an entire batch. */
export class PrivacyTokenIssuer<Context> {
  private readonly keys: KeyManager;
  private readonly quota: QuotaStore;
  private readonly maxBatch: number;
  private readonly clock: () => Date;

  constructor(private readonly options: IssuerOptions<Context>) {
    if (typeof options.validateUser !== 'function') {
      throw new Error('validateUser is required');
    }

    if (typeof options.metaFor !== 'function') {
      throw new Error('metaFor is required');
    }

    this.maxBatch = options.maxBatch ?? 16;
    if (!Number.isSafeInteger(this.maxBatch) || this.maxBatch < 1 || this.maxBatch > 16) {
      throw new Error('maxBatch must be an integer from 1 to 16');
    }

    this.keys = new KeyManager(options.keysDir);
    this.quota = options.quota ?? new DailyQuota(16);
    this.clock = options.clock ?? (() => new Date());
  }

  /** Load and check the current epoch's four keys before serving; fails if any is missing. */
  async initialize(): Promise<void> {
    await this.keys.current(this.clock());
  }

  /** The current and, if present, previous UTC month's four public keys. No authentication. */
  publishKeys(): Promise<{ keys: PublishedJwk[] }> {
    return this.keys.jwks(this.clock());
  }

  private async authenticate(context: Context): Promise<string> {
    const subject = await this.options.validateUser(context);
    if (typeof subject !== 'string' || !subject.trim()) {
      throw new IssuanceError(401, 'unauthorized');
    }

    return subject;
  }

  private async metaOf(subject: string): Promise<TokenMeta> {
    const meta = await this.options.metaFor(subject);
    if (!isTokenMeta(meta)) {
      throw new Error('metaFor must return an integer from 0 to 3');
    }

    return meta;
  }

  /** The authenticated account's current metadata value. */
  async meta(context: Context): Promise<MetaResponse> {
    return { meta: await this.metaOf(await this.authenticate(context)) };
  }

  async issue(context: Context, body: unknown): Promise<IssueResponse> {
    const client = await this.authenticate(context);

    const request = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const { blinded, meta } = request;
    if (!Array.isArray(blinded) || blinded.length < 1 || blinded.length > this.maxBatch) {
      throw new IssuanceError(400, 'bad_request');
    }

    if (!isTokenMeta(meta)) {
      throw new IssuanceError(400, 'bad_meta');
    }

    const now = this.clock();
    let set;
    try {
      set = await this.keys.current(now);
    } catch (error) {
      if (error instanceof KeyUnavailableError) {
        throw new IssuanceError(503, 'key_unavailable');
      }
      throw error;
    }

    const encodedLength = 4 * Math.ceil(set.kLen / 3);
    const messages = blinded.map((value: unknown) => {
      if (
        typeof value !== 'string' ||
        value.length !== encodedLength ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
      ) {
        throw new IssuanceError(400, 'bad_blinded');
      }

      const bytes = Buffer.from(value, 'base64');
      if (bytes.length !== set.kLen || bytes.toString('base64') !== value) {
        throw new IssuanceError(400, 'bad_blinded');
      }

      return bytes;
    });

    // A stale value costs nothing: the client refetches /meta and retries. This precedes the
    // range check, which depends on the value's key, so any mismatch is a 409.
    if (meta !== (await this.metaOf(client))) {
      throw new IssuanceError(409, 'meta_mismatch');
    }

    const key = set.keys[meta];
    for (const message of messages) {
      const valueInt = BigInt('0x' + message.toString('hex'));
      if (valueInt <= 0n || valueInt >= key.n) {
        throw new IssuanceError(400, 'bad_blinded');
      }
    }

    // Validate everything first; the store must reserve the whole batch atomically.
    if (!(await this.quota.take(client, messages.length, now))) {
      throw new IssuanceError(429, 'quota_exceeded');
    }

    // BlindSign every message with the key for this value. Nothing outlives the request.
    const signatures = messages.map((message) =>
      blindSign(key.signingKey, message).toString('base64'),
    );

    // Failed signing/audit does not refund quota: retries cannot exceed the daily cap.
    const event: IssuanceEvent = {
      ts: now.toISOString(),
      event: 'issue',
      client,
      count: signatures.length,
      epoch: set.epoch,
    };

    if (this.options.onIssue) {
      await this.options.onIssue(event);
    } else {
      process.stdout.write(JSON.stringify(event) + '\n');
    }

    return { kid: key.kid, signatures };
  }
}
