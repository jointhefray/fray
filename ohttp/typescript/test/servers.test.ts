import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { RELAY_SECRET } from './helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));

/** Start a server entry point that is expected to refuse its configuration. */
async function refusesToStart(entry: string, env: Record<string, string>) {
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', entry], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '',
      ...env,
    },
    timeout: 20_000,
  }).then(
    () => assert.fail(`${entry} started with invalid configuration`),
    (error: { code?: number; stderr?: string }) => error,
  );
  assert.notEqual(result.code, 0);
  return result.stderr ?? '';
}

test('relay server refuses to start without a valid FRAY_RELAY_AUTH, without printing it', async () => {
  const gateway = { GATEWAY_URL: 'https://gateway.example/ohttp' };
  assert.match(await refusesToStart('src/relay-server.ts', gateway), /FRAY_RELAY_AUTH must be set/);

  const weak = 'weak-value-do-not-print';
  const stderr = await refusesToStart('src/relay-server.ts', { ...gateway, FRAY_RELAY_AUTH: weak });
  assert.match(stderr, /FRAY_RELAY_AUTH must be set/);
  assert.equal(stderr.includes(weak), false);

  assert.match(
    await refusesToStart('src/relay-server.ts', {
      ...gateway,
      FRAY_RELAY_AUTH: RELAY_SECRET,
      FRAY_COUNTRY_HEADER: 'Fray-Country',
    }),
    /FRAY_COUNTRY_HEADER/,
  );
});

test('relay server refuses to start without GATEWAY_URL', async () => {
  assert.match(
    await refusesToStart('src/relay-server.ts', { FRAY_RELAY_AUTH: RELAY_SECRET }),
    /GATEWAY_URL/,
  );
});
