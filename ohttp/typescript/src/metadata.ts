/**
 * Coarse client metadata derived by the relay (contract v3, spec/relay.md).
 * Shared by the Node relay and the Cloudflare Worker. The exact-form validators also
 * state the checks a receiving gateway applies. Web APIs only: this module is bundled
 * into the Worker.
 */

export const DEVICES = [
  'android-mobile',
  'ios-mobile',
  'macos-desktop',
  'windows-desktop',
  'linux-desktop',
  'chromeos-desktop',
  'other',
] as const;

export type Device = (typeof DEVICES)[number];

export const UNKNOWN_COUNTRY = 'ZZ';
export const UNKNOWN_DEVICE: Device = 'other';

/** The only metadata headers a relay sends, and the only ones a gateway reads. */
export const COUNTRY_HEADER = 'fray-country';
export const DEVICE_HEADER = 'fray-device';
export const RELAY_AUTH_HEADER = 'fray-relay-auth';

const COUNTRY = /^[A-Z]{2}$/;

/** RFC 6750 b64token, so a secret is a valid header value and contains no list comma. */
const SECRET = /^[A-Za-z0-9\-._~+/]+=*$/;
export const MIN_SECRET_LENGTH = 32;
export const MAX_SECRET_LENGTH = 512;

/** RFC 9110 field-name token. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function isCountry(value: unknown): value is string {
  return typeof value === 'string' && COUNTRY.test(value);
}

export function isDevice(value: unknown): value is Device {
  return typeof value === 'string' && (DEVICES as readonly string[]).includes(value);
}

/** Uppercase ISO 3166-1 alpha-2. Tor (T1), unknown (XX), missing or malformed → ZZ. */
export function normalizeCountry(value: unknown): string {
  if (typeof value !== 'string') return UNKNOWN_COUNTRY;

  const trimmed = value.trim();

  // Validate ASCII before uppercasing: Unicode case mapping turns "ß" into "SS".
  if (!/^[A-Za-z]{2}$/.test(trimmed)) return UNKNOWN_COUNTRY;

  const country = trimmed.toUpperCase();

  return country === 'XX' ? UNKNOWN_COUNTRY : country;
}

const PLATFORMS = new Map<string, Device>([
  ['Android', 'android-mobile'],
  ['iOS', 'ios-mobile'],
  ['macOS', 'macos-desktop'],
  ['Windows', 'windows-desktop'],
  ['Linux', 'linux-desktop'],
  ['Chrome OS', 'chromeos-desktop'],
  ['ChromeOS', 'chromeos-desktop'],
]);

/** Checked in this order; the first matching substring wins. */
const USER_AGENTS: readonly (readonly [readonly string[], Device])[] = [
  [['Android'], 'android-mobile'],
  [['iPhone', 'iPad', 'iPod'], 'ios-mobile'],
  [['CrOS'], 'chromeos-desktop'],
  [['Windows NT'], 'windows-desktop'],
  [['Macintosh', 'Mac OS X'], 'macos-desktop'],
  [['Linux'], 'linux-desktop'],
];

/**
 * Sec-CH-UA-Platform when it maps to a known platform, else User-Agent, else `other`.
 * Only these two request headers are read. Neither is forwarded.
 */
export function deriveDevice(platform: string | null, userAgent: string | null): Device {
  if (platform !== null) {
    let value = platform.trim();

    // Structured-field string: "macOS". The mapped values contain no escapes.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
      value = value.slice(1, -1);

    const device = PLATFORMS.get(value);
    if (device) return device;
  }

  if (userAgent !== null) {
    for (const [needles, device] of USER_AGENTS) {
      if (needles.some((needle) => userAgent.includes(needle))) return device;
    }
  }

  return UNKNOWN_DEVICE;
}

export function deviceFromHeaders(headers: Headers): Device {
  return deriveDevice(headers.get('sec-ch-ua-platform'), headers.get('user-agent'));
}

export function isRelaySecret(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= MIN_SECRET_LENGTH &&
    value.length <= MAX_SECRET_LENGTH &&
    SECRET.test(value)
  );
}

/** One relay secret. Error messages never contain configuration values. */
export function parseRelaySecret(value: string | undefined, name = 'FRAY_RELAY_AUTH'): string {
  if (!isRelaySecret(value)) {
    throw new Error(
      `${name} must be set to a shared secret of ${MIN_SECRET_LENGTH}-${MAX_SECRET_LENGTH} base64/base64url characters`,
    );
  }

  return value;
}

/**
 * Country from a header that a fronting proxy sets and overwrites (e.g. CF-IPCountry).
 * Unset → every request is ZZ. A Fray-* header can never be the source.
 */
export function trustedCountryHeader(
  name: string | undefined,
): ((request: Request) => string | null) | undefined {
  if (name === undefined || name === '') return undefined;

  if (!HEADER_NAME.test(name) || name.toLowerCase().startsWith('fray-')) {
    throw new Error('FRAY_COUNTRY_HEADER must be a header name set by a trusted proxy');
  }

  return (request) => request.headers.get(name);
}
