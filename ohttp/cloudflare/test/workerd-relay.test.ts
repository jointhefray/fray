import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Wrangler already supplies esbuild, Miniflare and workerd. Execute the real
// relay and parser in that runtime: Node-only tests accept redirect: "error",
// whereas workerd rejects it before the TLS transport can open a socket.
test('relay works in workerd with simulated TLS sockets and no external network', async () => {
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
        import { createRelay } from '../typescript/src/relay.ts';
        import { createTlsTransport } from './src/tls-transport.ts';
        export default { async fetch(request) {
          const encode = (text) => new TextEncoder().encode(text);
          const writes = [];
          let connections = 0;
          let closed = false;
          const isKeys = new URL(request.url).pathname === '/ohttp-keys';
          const wire = request.headers.get('x-fixture') === 'redirect'
            ? 'HTTP/1.1 302 Found\\r\\nLocation: https://never-follow.invalid\\r\\nContent-Length: 0\\r\\n\\r\\n'
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
          const response = await createRelay({
            gatewayUrl: 'https://gateway.example/ohttp', fetch: createTlsTransport(connect),
          })(request);
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

  let unexpectedOutbound = 0;
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate,
      compatibilityFlags,
      script: outputFiles[0].text,
      cf: false,
      outboundService: () => {
        unexpectedOutbound++;
        return new Response(null, { status: 599 });
      },
    }),
  );

  try {
    const post = await (
      await runtime.dispatchFetch('https://relay.example/ohttp', {
        method: 'POST',
        headers: {
          'content-type': 'message/ohttp-req',
          authorization: 'synthetic-test-only',
          'cf-connecting-ip': '192.0.2.1',
        },
        body: new Uint8Array([1, 2, 3]),
      })
    ).json<any>();
    assert.equal(post.status, 200);
    assert.equal(post.body, 'abc');
    assert.equal(post.connections, 1);
    assert.equal(post.closed, true);
    assert.equal(post.headers['set-cookie'], undefined);
    assert.equal(post.writes.join('').includes('synthetic-test-only'), false);
    assert.equal(post.writes.join('').includes('192.0.2.1'), false);

    const keys = await (
      await runtime.dispatchFetch('https://relay.example/ohttp-keys')
    ).json<any>();
    assert.equal(keys.status, 200);
    assert.equal(keys.headers['content-type'], 'application/ohttp-keys');

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

    const oversized = await (
      await runtime.dispatchFetch('https://relay.example/ohttp', {
        method: 'POST',
        headers: { 'content-type': 'message/ohttp-req' },
        body: new Uint8Array(16 * 1024 + 1),
      })
    ).json<any>();
    assert.equal(oversized.status, 413);
    assert.equal(oversized.connections, 0);
    assert.equal(unexpectedOutbound, 0);
  } finally {
    await runtime.dispose();
  }
});
