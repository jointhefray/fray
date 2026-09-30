import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { creativeHash, lookupReportHash } from '../src/pipeline.js';

const schema = JSON.parse(
  await readFile(new URL('../../../spec/envelope.schema.json', import.meta.url), 'utf8'),
);
const validate = new Ajv2020.default({ strict: true }).compile(schema);
const token = {
  issuer: 'issuer.partner.example',
  kid: 'ep-2026-08',
  msg: Buffer.alloc(32).toString('base64'),
  sig: Buffer.alloc(256).toString('base64'),
};

function legacy() {
  return {
    v: 1,
    watchlist_version: 12,
    brand: 'example-fashion.com',
    platform: 'google.com',
    surface: 'search',
    observed_hour: '2026-08-29T14:00:00Z',
    creative: { title: 'Seasonal sale' },
    token,
  };
}

function lookup() {
  return {
    ...legacy(),
    v: 2,
    observed_domain: 'shop.example-fashion.com',
    creative: null,
    advertiser: { id: 'AR1234567890', name: 'Example Merchant Ltd', country: 'GB' },
    lookup: {
      kind: 'google-batchexecute',
      batchCode: 'original+opaque/batch==',
      atParameter: 'source_token-123%3a1788000000123',
    },
  };
}

test('schema accepts both versions without broadening the legacy v1 field set', () => {
  assert.equal(validate(legacy()), true);
  assert.equal(validate({ ...legacy(), platform: 'youtube.com', surface: 'feed' }), true);
  assert.equal(validate(lookup()), true);
  assert.equal(validate({ ...lookup(), creative: legacy().creative }), true);

  for (const field of ['lookup', 'advertiser', 'observed_domain']) {
    assert.equal(validate({ ...legacy(), [field]: lookup()[field] }), false);
  }
  assert.equal(validate({ ...legacy(), creative: null }), false);
});

test('both creative schemas require only title and reject the removed destination field', () => {
  for (const report of [legacy(), lookup()]) {
    report.creative = { title: 'An ad without a click URL' };
    assert.equal(validate(report), true);

    report.creative.final_domain = 'destination.example';
    assert.equal(validate(report), false, 'removed fields remain schema errors');

    report.creative = { body: 'Body alone is not a usable creative' };
    assert.equal(validate(report), false);
  }
});

test('v1 grouping is the SHA-256 of the normalized title alone', () => {
  const title = 'CAFE\u0301 Sale';
  const expected = createHash('sha256').update('café sale').digest('hex');

  assert.equal(creativeHash(title), expected);
  assert.equal(creativeHash('Café sale'), expected);
  assert.notEqual(creativeHash('Another sale'), expected);
});

test('v2 schema strictly rejects extra fields and malformed lookup/details', () => {
  const mutations = [
    (report) => {
      report.user_id = 'unexpected';
    },
    (report) => {
      report.lookup.adKey = 'local-only';
    },
    (report) => {
      report.lookup.atParameterEncoded = 'helper';
    },
    (report) => {
      report.advertiser.raw = {};
    },
    (report) => {
      report.advertiser.name = ' ';
    },
    (report) => {
      report.advertiser.name = 'bad\u0000name';
    },
    (report) => {
      report.advertiser.id = 'ARletters';
    },
    (report) => {
      report.advertiser.country = '';
    },
    (report) => {
      report.lookup.atParameter = 'not-an-at-token';
    },
    (report) => {
      report.lookup.batchCode = 'not opaque';
    },
    (report) => {
      report.lookup.batchCode = '';
    },
    (report) => {
      report.platform = 'youtube.com';
    },
    (report) => {
      report.surface = 'feed';
    },
    (report) => {
      report.token = { ...token, client_id: 'not-allowed' };
    },
    (report) => {
      delete report.creative;
    },
  ];

  for (const mutate of mutations) {
    const report = lookup();
    mutate(report);
    assert.equal(validate(report), false, mutate.toString());
  }
});

test('v2 grouping ignores page/request tokens but retains domain, advertiser and creative identity', () => {
  const first = lookup();
  const second = lookup();
  second.lookup = {
    kind: 'google-batchexecute',
    batchCode: 'different-batch',
    atParameter: 'other_token-123:1788000000999',
  };
  assert.equal(lookupReportHash(first), lookupReportHash(second));

  second.advertiser = { ...first.advertiser, name: 'Alternate spelling' };
  assert.equal(
    lookupReportHash(first),
    lookupReportHash(second),
    'an available AR id is the identity',
  );
  second.advertiser.id = 'AR9999999999';
  assert.notEqual(lookupReportHash(first), lookupReportHash(second));
  second.advertiser = first.advertiser;
  second.observed_domain = 'example-fashion.com';
  assert.notEqual(lookupReportHash(first), lookupReportHash(second));
  second.observed_domain = first.observed_domain;
  second.creative = legacy().creative;
  assert.notEqual(lookupReportHash(first), lookupReportHash(second));
  assert.notEqual(lookupReportHash(second), creativeHash(second.creative.title));

  first.creative = { title: 'CAFE\u0301 Sale' };
  second.creative = { title: 'Café sale', display_url: 'shop.example-fashion.com/sale' };
  assert.equal(lookupReportHash(first), lookupReportHash(second));
  second.creative.title = 'Another sale';
  assert.notEqual(lookupReportHash(first), lookupReportHash(second));
});

test('name/country fallback grouping normalizes text and handles missing advertiser IDs', () => {
  const first = lookup();
  const second = lookup();
  delete first.advertiser.id;
  delete second.advertiser.id;
  second.advertiser.name = first.advertiser.name.toUpperCase();
  second.advertiser.country = 'gb';
  assert.equal(lookupReportHash(first), lookupReportHash(second));
  second.advertiser.country = 'US';
  assert.notEqual(lookupReportHash(first), lookupReportHash(second));
});
