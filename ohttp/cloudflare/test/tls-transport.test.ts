import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRelay } from '../../typescript/src/relay.js';
import { createTlsTransport } from '../src/tls-transport.js';

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
function socketFixture(chunks: Uint8Array[]) {
  const writes: Uint8Array[] = [];
  let closed = false;
  const addresses: unknown[] = [];
  const connect = (address: unknown, options: unknown) => {
    addresses.push({ address, options });
    return {
      opened: Promise.resolve(),
      closed: Promise.resolve(),
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          writes.push(chunk.slice());
        },
      }),
      async close() {
        closed = true;
      },
    };
  };
  return { connect, writes, addresses, isClosed: () => closed };
}

test('Worker socket writes only fixed HTTP headers and ciphertext, with TLS enabled', async () => {
  const fixture = socketFixture([
    encode(
      'HTTP/1.1 200 OK\r\nContent-Type: message/ohttp-res\r\nContent-Length: 3\r\nSet-Cookie: user=private\r\n\r\n',
    ),
    new Uint8Array([4, 5, 6]),
  ]);
  const relay = createRelay({
    gatewayUrl: 'https://gateway.example/ohttp',
    fetch: createTlsTransport(fixture.connect),
  });
  const result = await relay(
    new Request('https://relay.example/ohttp', {
      method: 'POST',
      headers: {
        'content-type': 'message/ohttp-req',
        'cf-connecting-ip': '192.0.2.1',
        'x-real-ip': '192.0.2.1',
        cookie: 'identity',
        authorization: 'secret',
      },
      body: new Uint8Array([1, 2, 3]),
    }),
  );
  assert.equal(result.status, 200);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), new Uint8Array([4, 5, 6]));
  assert.equal(result.headers.get('set-cookie'), null);
  assert.deepEqual(fixture.addresses, [
    { address: { hostname: 'gateway.example', port: 443 }, options: { secureTransport: 'on' } },
  ]);
  assert.equal(
    decode(fixture.writes[0]),
    [
      'POST /ohttp HTTP/1.1',
      'Host: gateway.example',
      'Connection: close',
      'Accept-Encoding: identity',
      'Accept: message/ohttp-res',
      'Content-Type: message/ohttp-req',
      'Content-Length: 3',
      '',
      '',
    ].join('\r\n'),
  );
  assert.deepEqual(fixture.writes[1], new Uint8Array([1, 2, 3]));
  assert.equal(fixture.isClosed(), true);
});

test('handles HTTP headers split across packets and chunked response bytes', async () => {
  const fixture = socketFixture([
    encode('HTTP/1.1 200 OK\r\nContent-Ty'),
    encode('pe: message/ohttp-res\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nab\r\n'),
    encode('1\r\nc\r\n0\r\n\r\n'),
  ]);
  const result = await createTlsTransport(fixture.connect)(
    new Request('https://gateway.example/ohttp', { method: 'POST', body: 'ciphertext' }),
  );
  assert.equal(await result.text(), 'abc');
});

test('rejects truncated, oversized, compressed and malformed upstream responses', async () => {
  for (const wire of [
    'HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nab',
    'HTTP/1.1 200 OK\r\nContent-Length: 20000\r\n\r\n' + 'x'.repeat(20000),
    'HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 2\r\n\r\nab',
    'not-http-at-all\r\n\r\n',
  ]) {
    const fixture = socketFixture([encode(wire)]);
    await assert.rejects(
      createTlsTransport(fixture.connect)(
        new Request('https://gateway.example/ohttp', { method: 'POST', body: 'ciphertext' }),
      ),
    );
    assert.equal(fixture.isClosed(), true);
  }
});

test('does not follow gateway redirects or leak Location', async () => {
  const fixture = socketFixture([
    encode('HTTP/1.1 302 Found\r\nLocation: https://attacker.example\r\nContent-Length: 0\r\n\r\n'),
  ]);
  const relay = createRelay({
    gatewayUrl: 'https://gateway.example/ohttp',
    fetch: createTlsTransport(fixture.connect),
  });
  const result = await relay(
    new Request('https://relay.example/ohttp', {
      method: 'POST',
      headers: { 'content-type': 'message/ohttp-req' },
      body: 'ciphertext',
    }),
  );
  assert.equal(result.status, 502);
  assert.equal(result.headers.get('location'), null);
  assert.equal(fixture.addresses.length, 1);
});

test('refuses plaintext transport before opening a socket', async () => {
  const fixture = socketFixture([]);
  await assert.rejects(
    createTlsTransport(fixture.connect)(new Request('http://gateway.example/ohttp')),
  );
  assert.equal(fixture.addresses.length, 0);
});
