// TEST ONLY: a stdio bridge for the Python interop test (token-issuer/python/test_interop.py).
// It serves this package's issuer, with the committed TEST ONLY fixture keys, through Fastify's
// inject(): one JSON request per input line, one JSON response per output line. No network.
// "Bearer interop-<m>" authenticates a test account whose metadata value is m.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { FastifyRequest } from 'fastify';
import { PrivacyTokenIssuer, buildServer } from '../src/index.js';
import { writeTestEpoch } from './support.js';

const directory = mkdtempSync(join(tmpdir(), 'fray-interop-'));
try {
  await writeTestEpoch(directory, 'ep-2026-01', 0);
  const issuer = new PrivacyTokenIssuer<FastifyRequest>({
    keysDir: directory,
    clock: () => new Date('2026-01-05T12:00:00Z'),
    validateUser: (request) => {
      const match = /^Bearer interop-([0-3])$/.exec(request.headers.authorization ?? '');
      return match ? `account-${match[1]}` : null;
    },
    metaFor: (subject) => Number(subject.slice(-1)),
    onIssue: () => {},
  });
  const app = await buildServer(issuer);

  for await (const line of createInterface({ input: process.stdin })) {
    const { method, url, headers, body } = JSON.parse(line);
    const response = await app.inject({
      method,
      url,
      headers,
      ...(body === undefined ? {} : { payload: body }),
    });
    process.stdout.write(
      JSON.stringify({
        status: response.statusCode,
        cacheControl: response.headers['cache-control'] ?? null,
        body: response.json(),
      }) + '\n',
    );
  }

  await app.close();
} finally {
  rmSync(directory, { recursive: true, force: true });
}
