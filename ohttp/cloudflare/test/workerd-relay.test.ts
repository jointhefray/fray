import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Synthetic, test-only value in the accepted secret format.
const RELAY_SECRET = 'test-only-relay-secret-'.padEnd(44, 'A');
const MAX_MESSAGE_BYTES = 655360;

// Wrangler already supplies esbuild, Miniflare and workerd. Execute the real
// Worker (env handling, request.cf, relay and parser) in that runtime with a
// simulated socket: Node-only tests accept redirect: "error", whereas workerd
// rejects it before the TLS transport can open a socket.
async function startWorker(bindings: Record<string, string>) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const config = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const compatibilityDate = /compatibility_date\s*=\s*"([^"]+)"/.exec(config)?.[1];
  const compatibilityFlags = JSON.parse(
    /compatibility_flags\s*=\s*(\[[^\]]*\])/.exec(config)?.[1] ?? '[]',
  );
  assert.ok(compatibilityDate, 'Test must use the deployed compatibility date');

  const { outputFiles } = await build({
    stdin: {
      resolveDir: root,
      loader: 'ts',
      contents: `
        import { createWorker } from './src/worker.ts';
        export default { async fetch(request, env) {
          const encode = (text) => new TextEncoder().encode(text);
          const writes = [];
          let connections = 0;
          let closed = false;
          const isKeys = new URL(request.url).pathname === '/ohttp-keys';
          const fixture = request.headers.get('x-fixture');
          const wire = fixture === 'redirect'
            ? 'HTTP/1.1 302 Found\\r\\nLocation: https://never-follow.invalid\\r\\nContent-Length: 0\\r\\n\\r\\n'
            : fixture === 'unavailable'
            ? 'HTTP/1.1 503 Service Unavailable\\r\\nContent-Length: 7\\r\\n\\r\\nprivate'
            : 'HTTP/1.1 200 OK\\r\\nContent-Type: ' + (isKeys ? 'application/ohttp-keys' : 'message/ohttp-res') +
              '\\r\\nTransfer-Encoding: chunked\\r\\nSet-Cookie: identity=discard\\r\\n\\r\\n2\\r\\nab\\r\\n1\\r\\nc\\r\\n0\\r\\n\\r\\n';
          const connect = () => {
            connections++;
            return {
              opened: Promise.resolve(), closed: Promise.resolve(),
              readable: new ReadableStream({ start(controller) {
                controller.enqueue(encode(wire.slice(0, 27)));
                controller.enqueue(encode(wire.slice(27)));
                controller.close();
              }}),
              writable: new WritableStream({ write(chunk) {
                writes.push(new TextDecoder().decode(chunk));
              }}),
              async close() { closed = true; },
            };
          };
          const response = await createWorker(connect).fetch(request, env);
          return Response.json({ status: response.status, body: await response.text(),
            headers: Object.fromEntries(response.headers), connections, closed, writes });
        }};
      `,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    external: ['node:buffer'],
  });

  const outbound = { count: 0 };
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate,
      compatibilityFlags,
      script: outputFiles[0].text,
      bindings,
      cf: false,
      outboundService: () => {
        outbound.count++;
        return new Response(null, { status: 599 });
      },
    }),
  );
  return { runtime, outbound };
}

const preamble = (writes: string[]) => writes[0].split('\r\n');

test('relay works in workerd with simulated TLS sockets and no external network', async () => {
  const { runtime, outbound } = await startWorker({
    GATEWAY_URL: 'https://gateway.example/ohttp',
    FRAY_RELAY_AUTH: RELAY_SECRET,
  });

  try {
    const post = await (
      await runtime.dispatchFetch('https://relay.example/ohttp', {
        method: 'POST',
        headers: {
          'content-type': 'message/ohttp-req',
          authorization: 'synthetic-test-only',
          'cf-connecting-ip': '192.0.2.1',
          'cf-ipcountry': 'US',
          'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile',
          'sec-ch-ua-platform': '"macOS"',
          'fray-country': 'US',
          'fray-device': 'ios-mobile',
          'fray-relay-auth': 'client-supplied-'.padEnd(40, 'x'),
        },
        body: new Uint8Array([1, 2, 3]),
        cf: { country: 'GB' },
      })
    ).json<any>();
    assert.equal(post.status, 200);
    assert.equal(post.body, 'abc');
    assert.equal(post.connections, 1);
    assert.equal(post.closed, true);
    assert.equal(post.headers['set-cookie'], undefined);
    assert.deepEqual(preamble(post.writes), [
      'POST /ohttp HTTP/1.1',
      'Host: gateway.example',
      'Connection: close',
      'Accept-Encoding: identity',
      'Accept: message/ohttp-res',
      'Content-Type: message/ohttp-req',
      'Content-Length: 3',
      'Fray-Country: GB',
      'Fray-Device: macos-desktop',
      `Fray-Relay-Auth: ${RELAY_SECRET}`,
      '',
      '',
    ]);
    const wire = post.writes.join('');
    for (const leaked of ['synthetic-test-only', '192.0.2.1', 'Android', 'client-supplied', 'US']) {
      assert.equal(wire.includes(leaked), false, leaked);
    }

    // Tor exit, unknown, absent and malformed geolocation all become ZZ. (Miniflare
    // merges request cf over a fallback whose country is US, so absence is null here.)
    for (const cf of [
      { country: 'T1' },
      { country: 'XX' },
      { country: null },
      { country: 'GBR' },
    ]) {
      const result = await (
        await runtime.dispatchFetch('https://relay.example/ohttp', {
          method: 'POST',
          headers: { 'content-type': 'message/ohttp-req' },
          body: 'synthetic',
          cf,
        })
      ).json<any>();
      assert.equal(result.status, 200);
      assert.ok(preamble(result.writes).includes('Fray-Country: ZZ'), JSON.stringify(cf));
      assert.ok(preamble(result.writes).includes('Fray-Device: other'));
    }

    const keys = await (
      await runtime.dispatchFetch('https://relay.example/ohttp-keys')
    ).json<any>();
    assert.equal(keys.status, 200);
    assert.equal(keys.headers['content-type'], 'application/ohttp-keys');
    assert.equal(keys.writes.join('').includes('Fray-'), false);

    const redirect = await (
      await runtime.dispatchFetch('https://relay.example/ohttp', {
        method: 'POST',
        headers: { 'content-type': 'message/ohttp-req', 'x-fixture': 'redirect' },
        body: 'synthetic',
      })
    ).json<any>();
    assert.equal(redirect.status, 502);
    assert.equal(redirect.headers.location, undefined);
    assert.equal(redirect.connections, 1);

    const unavailable = await (
      await runtime.dispatchFetch('https://relay.example/ohttp', {
        method: 'POST',
        headers: { 'content-type': 'message/ohttp-req', 'x-fixture': 'unavailable' },
        body: 'synthetic',
      })
    ).json<any>();
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body, '');

    const largest = await (
      await runtime.dispatchFetch('https://relay.example/ohttp', {
        method: 'POST',
        headers: { 'content-type': 'message/ohttp-req' },
        body: new Uint8Array(MAX_MESSAGE_BYTES),
      })
    ).json<any>();
    assert.equal(largest.status, 200);
    assert.ok(preamble(largest.writes).includes(`Content-Length: ${MAX_MESSAGE_BYTES}`));

    const oversized = await (
      await runtime.dispatchFetch('https://relay.example/ohttp', {
        method: 'POST',
        headers: { 'content-type': 'message/ohttp-req' },
        body: new Uint8Array(MAX_MESSAGE_BYTES + 1),
      })
    ).json<any>();
    assert.equal(oversized.status, 413);
    assert.equal(oversized.connections, 0);
    assert.equal(outbound.count, 0);
  } finally {
    await runtime.dispose();
  }
});

test('Worker without a valid FRAY_RELAY_AUTH secret forwards nothing', async () => {
  for (const bindings of [
    { GATEWAY_URL: 'https://gateway.example/ohttp' },
    { GATEWAY_URL: 'https://gateway.example/ohttp', FRAY_RELAY_AUTH: 'too-short' },
  ]) {
    const { runtime, outbound } = await startWorker(bindings);
    try {
      for (const [path, init] of [
        ['/ohttp', { method: 'POST', headers: { 'content-type': 'message/ohttp-req' }, body: 'x' }],
        ['/ohttp-keys', {}],
      ] as const) {
        const result = await (
          await runtime.dispatchFetch(`https://relay.example${path}`, init)
        ).json<any>();
        assert.equal(result.status, 503);
        assert.equal(result.body, '');
        assert.equal(result.connections, 0);
      }
      assert.equal(outbound.count, 0);
    } finally {
      await runtime.dispose();
    }
  }
});
