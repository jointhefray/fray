// Cross-language interop: the Python issuer (driven through its TEST ONLY stdio bridge) signs,
// and @cloudflare/blindrsa-ts RSABSSA.SHA384.PSS.Deterministic finalizes and verifies. Both
// issuers and the library's blindSign must agree byte for byte.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PrivacyTokenIssuer } from '../src/index.js';
import { importPublicJwk, referencePrivateKey, suite, u8, writeTestEpoch } from './support.js';

const python =
  process.env.FRAY_INTEROP_PYTHON ??
  fileURLToPath(new URL('../../python/.venv/bin/python', import.meta.url));
const bridgeScript = fileURLToPath(new URL('../../python/interop_bridge.py', import.meta.url));

interface BridgeResponse {
  status: number;
  cacheControl: string | null;
  body: any;
}

function startBridge() {
  const child = spawn(python, [bridgeScript], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
  return {
    async request(request: object): Promise<BridgeResponse> {
      child.stdin!.write(JSON.stringify(request) + '\n');
      const { value, done } = await lines.next();
      if (done) throw new Error('Python bridge exited');
      return JSON.parse(value);
    },
    async close() {
      child.stdin!.end();
      if (child.exitCode === null) await once(child, 'exit');
    },
  };
}

test(
  'Python-issued signatures finalize and verify with @cloudflare/blindrsa-ts',
  { skip: existsSync(python) ? false : `no Python at ${python} (set FRAY_INTEROP_PYTHON)` },
  async (t) => {
    const bridge = startBridge();
    t.after(() => bridge.close());
    const directory = mkdtempSync(join(tmpdir(), 'fray-interop-local-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    await writeTestEpoch(directory, 'ep-2026-01', 0);
    const local = new PrivacyTokenIssuer<string>({
      keysDir: directory,
      clock: () => new Date('2026-01-05T12:00:00Z'),
      validateUser: (subject) => subject,
      metaFor: (subject) => Number(subject.slice(-1)),
      onIssue: () => {},
    });

    const jwks = await bridge.request({ method: 'GET', url: '/.well-known/jwks.json' });
    assert.equal(jwks.status, 200);
    assert.deepEqual(jwks.body, await local.publishKeys());
    const publicKeys = await Promise.all(
      [0, 1, 2, 3].map((meta) => importPublicJwk(jwks.body.keys[meta])),
    );

    for (const meta of [0, 1, 2, 3] as const) {
      const headers = { authorization: `Bearer interop-${meta}` };
      const metaResponse = await bridge.request({ method: 'GET', url: '/meta', headers });
      assert.deepEqual(
        [metaResponse.status, metaResponse.cacheControl, metaResponse.body],
        [200, 'no-store', { meta }],
      );

      assert.equal(jwks.body.keys[meta].kid, `ep-2026-01.${meta}`);
      const work = await Promise.all(
        Array.from({ length: 3 }, async () => {
          const msg = suite.prepare(randomBytes(32));
          return { msg, ...(await suite.blind(publicKeys[meta], msg)) };
        }),
      );
      const body = { meta, blinded: work.map((w) => Buffer.from(w.blindedMsg).toString('base64')) };

      const mismatch = await bridge.request({
        method: 'POST',
        url: '/issue',
        headers,
        body: { ...body, meta: (meta + 1) % 4 },
      });
      assert.deepEqual([mismatch.status, mismatch.body], [409, { error: 'meta_mismatch' }]);

      const issued = await bridge.request({ method: 'POST', url: '/issue', headers, body });
      assert.equal(issued.status, 200);
      assert.equal(issued.body.kid, `ep-2026-01.${meta}`);
      // Deterministic RSASP1: Python, this package and blindrsa-ts agree byte for byte.
      assert.deepEqual(issued.body, await local.issue(`account-${meta}`, body));
      const reference = await referencePrivateKey(0, meta);
      assert.deepEqual(
        Buffer.from(await suite.blindSign(reference, work[0].blindedMsg)),
        Buffer.from(issued.body.signatures[0], 'base64'),
      );

      for (const [index, w] of work.entries()) {
        const blindSig = u8(Buffer.from(issued.body.signatures[index], 'base64'));
        const sig = await suite.finalize(publicKeys[meta], w.msg, blindSig, w.inv);
        assert.equal(await suite.verify(publicKeys[meta], sig, w.msg), true);
        for (const other of [0, 1, 2, 3].filter((value) => value !== meta)) {
          assert.equal(await suite.verify(publicKeys[other], sig, w.msg), false);
        }
      }
    }
  },
);
