import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEVICES,
  deriveDevice,
  deviceFromHeaders,
  isCountry,
  isDevice,
  normalizeCountry,
  parseRelaySecret,
  trustedCountryHeader,
} from '../src/metadata.js';
import { RELAY_SECRET, vectors } from './helpers.js';

test('country derivation table: uppercase alpha-2, T1/XX/missing/malformed become ZZ', () => {
  for (const { input, expected } of vectors.country) {
    assert.equal(normalizeCountry(input), expected, JSON.stringify(input));
  }
  for (const input of [undefined, 44, { country: 'GB' }, ['GB']]) {
    assert.equal(normalizeCountry(input), 'ZZ');
  }
});

test('device derivation table: client hint first, then ordered user-agent substrings, else other', () => {
  for (const { name, platform, userAgent, expected } of vectors.device) {
    assert.equal(deriveDevice(platform, userAgent), expected, name);

    const headers = new Headers();
    if (platform !== null) headers.set('sec-ch-ua-platform', platform);
    if (userAgent !== null) headers.set('user-agent', userAgent);
    assert.equal(deviceFromHeaders(headers), expected, `${name} (headers)`);
  }
});

test('vectors cover every device value and both derivation sources', () => {
  const fromHint = new Set(
    vectors.device
      .filter((v) => v.platform !== null && v.userAgent === null)
      .map((v) => v.expected),
  );
  const fromUserAgent = new Set(
    vectors.device.filter((v) => v.platform === null).map((v) => v.expected),
  );
  assert.deepEqual([...fromHint].sort(), [...DEVICES].sort());
  assert.deepEqual([...fromUserAgent].sort(), [...DEVICES].sort());
});

test('exact-form validators, as the Worker transport and a gateway apply them', () => {
  for (const value of ['GB', 'ZZ']) assert.equal(isCountry(value), true);
  for (const value of ['gb', 'GBR', 'G', '', ' GB', null, 1]) assert.equal(isCountry(value), false);
  for (const value of DEVICES) assert.equal(isDevice(value), true);
  for (const value of ['mobile', 'desktop', 'MACOS-DESKTOP', 'tablet', '', null, 'other ']) {
    assert.equal(isDevice(value), false);
  }
});

test('relay secrets have a fixed format and errors never echo the value', () => {
  assert.equal(parseRelaySecret(RELAY_SECRET), RELAY_SECRET);

  for (const value of [
    undefined,
    '',
    'too-short-secret-value',
    `${RELAY_SECRET} trailing`,
    `${RELAY_SECRET}\r\nX-Injected: 1`,
    'x'.repeat(513),
  ]) {
    assert.throws(
      () => parseRelaySecret(value),
      (error: Error) => !value || !error.message.includes(value),
    );
  }
});

test('trusted country header must be a plain header name and never a Fray-* header', () => {
  assert.equal(trustedCountryHeader(undefined), undefined);
  assert.equal(trustedCountryHeader(''), undefined);
  const read = trustedCountryHeader('CF-IPCountry')!;
  assert.equal(
    read(new Request('https://relay.example', { headers: { 'cf-ipcountry': 'GB' } })),
    'GB',
  );
  for (const name of ['Fray-Country', 'fray-anything', 'CF IPCountry', 'Country:', 'a\r\nb']) {
    assert.throws(() => trustedCountryHeader(name), /FRAY_COUNTRY_HEADER/);
  }
});
