/** Public registry document defined by spec/watchlist.schema.json. */
export interface Watchlist {
  v: 1;
  version: number;
  published: string;
  expires: string;
  entries: Array<{
    domain: string;
    brand_terms: string[];
    authorized_domains: string[];
    policy?: 'open' | 'closed' | 'none';
    authorized_advertiser_ids?: string[];
  }>;
}

const HOSTNAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ADVERTISER_ID = /^AR[0-9]{1,62}$/;
const DOCUMENT_KEYS = ['v', 'version', 'published', 'expires', 'entries'];
const ENTRY_KEYS = [
  'domain',
  'brand_terms',
  'authorized_domains',
  'policy',
  'authorized_advertiser_ids',
];

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error('Invalid public registry snapshot');
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function hostname(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 253 && HOSTNAME.test(value);
}

/** Require a real RFC 3339 calendar date; Date.parse alone accepts rolled-over dates. */
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1] &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

/** Independent implementation of the public schema; no browser SDK dependency. */
export function assertPublicWatchlist(value: unknown): asserts value is Watchlist {
  requireValid(object(value) && hasOnlyKeys(value, DOCUMENT_KEYS));
  requireValid(value.v === 1 && Number.isSafeInteger(value.version) && Number(value.version) >= 1);
  requireValid(timestamp(value.published) && timestamp(value.expires));
  requireValid(Array.isArray(value.entries) && value.entries.length <= 10000);
  const seen = new Set<string>();
  for (const entry of value.entries) {
    requireValid(object(entry) && hasOnlyKeys(entry, ENTRY_KEYS));
    requireValid(hostname(entry.domain) && !seen.has(entry.domain));
    seen.add(entry.domain);
    requireValid(Array.isArray(entry.brand_terms) && entry.brand_terms.length <= 10);
    for (const term of entry.brand_terms) {
      requireValid(typeof term === 'string');
      const length = Array.from(term).length;
      requireValid(length >= 3 && length <= 60);
    }
    requireValid(Array.isArray(entry.authorized_domains) && entry.authorized_domains.length <= 50);
    requireValid(entry.authorized_domains.every(hostname));
    requireValid(
      !Object.hasOwn(entry, 'policy') ||
        entry.policy === 'open' ||
        entry.policy === 'closed' ||
        entry.policy === 'none',
    );
    if (Object.hasOwn(entry, 'authorized_advertiser_ids')) {
      requireValid(
        Array.isArray(entry.authorized_advertiser_ids) &&
          entry.authorized_advertiser_ids.length <= 1000,
      );
      requireValid(
        entry.authorized_advertiser_ids.every(
          (id: unknown) => typeof id === 'string' && ADVERTISER_ID.test(id),
        ),
      );
      requireValid(entry.policy !== 'none' || entry.authorized_advertiser_ids.length === 0);
    }
  }
}

export function watchlistExpired(document: Watchlist, now: number): boolean {
  return !(Date.parse(document.expires) > now);
}
