import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPublicWatchlist, watchlistExpired } from '../src/watchlist.js';

const entry = () => ({
  domain: 'example.com',
  brand_terms: ['Example'],
  authorized_domains: ['example.com'],
  policy: 'closed',
  authorized_advertiser_ids: ['AR123456'],
});
const document = (row: unknown = entry()) => ({
  v: 1,
  version: 1,
  published: '2026-09-30T12:00:00Z',
  expires: '2026-10-01T12:00:00Z',
  entries: [row],
});

test('independent validator accepts the public schema, optional fields, offsets and Unicode character lengths', () => {
  const doc = document({
    domain: 'example.com',
    brand_terms: ['😀😀😀', '😀'.repeat(60)],
    authorized_domains: Array(50).fill('example.com'),
  });
  doc.published = '2024-02-29T12:34:56.123+01:30';
  assertPublicWatchlist(doc);
  assert.equal(watchlistExpired(doc, Date.parse(doc.expires) - 1), false);
  assert.equal(watchlistExpired(doc, Date.parse(doc.expires)), true);
  assert.equal(watchlistExpired(doc, NaN), true);
});

test('schema array and string limits reject out-of-bounds values', () => {
  for (const change of [
    { brand_terms: Array(11).fill('Example') },
    { brand_terms: ['ab'] },
    { brand_terms: ['a'.repeat(61)] },
    { authorized_domains: Array(51).fill('example.com') },
    { authorized_advertiser_ids: Array(1001).fill('AR123') },
    { domain: `${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(62)}` },
  ]) {
    assert.throws(() => assertPublicWatchlist(document({ ...entry(), ...change })));
  }
});

test('invalid calendar dates, undeclared fields, duplicate domains and contradictory none policies are rejected', () => {
  for (const date of [
    '2026-02-30T12:00:00Z',
    '2026-09-30',
    '2026-13-01T12:00:00Z',
    '2026-09-30T24:00:00Z',
  ]) {
    assert.throws(() => assertPublicWatchlist({ ...document(), expires: date }));
  }
  assert.throws(() => assertPublicWatchlist({ ...document(), private_account: 'not public' }));
  assert.throws(() =>
    assertPublicWatchlist(document({ ...entry(), private_account: 'not public' })),
  );
  assert.throws(() => assertPublicWatchlist({ ...document(), entries: [entry(), entry()] }));
  assert.throws(() => assertPublicWatchlist(document({ ...entry(), policy: 'none' })));
  assertPublicWatchlist(document({ ...entry(), policy: 'none', authorized_advertiser_ids: [] }));
  assert.throws(() =>
    assertPublicWatchlist(document({ ...entry(), authorized_advertiser_ids: ['MS123'] })),
  );
});
