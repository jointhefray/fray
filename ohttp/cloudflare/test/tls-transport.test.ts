import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRelay } from '../../typescript/src/relay.js';
import { FrayOhttpClient } from '../../typescript/src/client.js';
import { MAX_MESSAGE_BYTES } from '../../typescript/src/http.js';
import { publicKeys, standInGateway } from '../../typescript/test/helpers.js';
import { createTlsTransport } from '../src/tls-transport.js';

// Synthetic, test-only value in the accepted secret format.
const relayAuth = 'test-only-relay-secret-'.padEnd(44, 'A');
const metadata = {
  'fray-country': 'GB',
  'fray-device': 'macos-desktop',
  'fray-relay-auth': relayAuth,
};
const gatewayPost = (body: BodyInit = 'ciphertext', headers: HeadersInit = metadata) =>
  new Request('https://gateway.example/ohttp', { method: 'POST', headers, body });
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

test('Worker socket writes only fixed HTTP headers, relay metadata and ciphertext, with TLS enabled', async () => {
  const fixture = socketFixture([
    encode(
      'HTTP/1.1 200 OK\r\nContent-Type: message/ohttp-res\r\nContent-Length: 3\r\nSet-Cookie: user=private\r\n\r\n',
    ),
    new Uint8Array([4, 5, 6]),
  ]);
  const relay = createRelay({
    gatewayUrl: 'https://gateway.example/ohttp',
    relayAuth,
    country: () => 'GB',
    fetch: createTlsTransport(fixture.connect),
  });
  const result = await relay(
    new Request('https://relay.example/ohttp', {
      method: 'POST',
      headers: {
        'content-type': 'message/ohttp-req',
        'cf-connecting-ip': '192.0.2.1',
        'cf-ipcountry': 'US',
        'x-real-ip': '192.0.2.1',
        cookie: 'identity',
        authorization: 'secret',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'sec-ch-ua-platform': '"macOS"',
        'fray-country': 'US',
        'fray-device': 'ios-mobile',
        'fray-relay-auth': 'client-supplied-'.padEnd(40, 'x'),
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
      'Fray-Country: GB',
      'Fray-Device: macos-desktop',
      `Fray-Relay-Auth: ${relayAuth}`,
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
  const result = await createTlsTransport(fixture.connect)(gatewayPost());
  assert.equal(await result.text(), 'abc');
});

test('refuses ciphertext without exact relay metadata, before opening a socket', async () => {
  for (const headers of [
    {},
    { ...metadata, 'fray-relay-auth': '' },
    { ...metadata, 'fray-relay-auth': 'short' },
    { ...metadata, 'fray-country': 'gb' },
    { ...metadata, 'fray-country': 'GB, US' },
    { ...metadata, 'fray-relay-auth': `${relayAuth} X-Injected: 1` },
    { ...metadata, 'fray-device': 'tablet' },
    { 'fray-country': 'GB', 'fray-device': 'macos-desktop' },
  ]) {
    const fixture = socketFixture([]);
    await assert.rejects(
      createTlsTransport(fixture.connect)(gatewayPost('ciphertext', headers as HeadersInit)),
    );
    assert.equal(fixture.addresses.length, 0, JSON.stringify(headers));
  }
});

test('bounds the request body at 655360 bytes', async () => {
  const fixture = socketFixture([]);
  await assert.rejects(
    createTlsTransport(fixture.connect)(gatewayPost(new Uint8Array(MAX_MESSAGE_BYTES + 1))),
  );
  assert.equal(fixture.addresses.length, 0);
});

test('rejects truncated, oversized, compressed and malformed upstream responses', async () => {
  for (const wire of [
    'HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nab',
    'HTTP/1.1 200 OK\r\nContent-Length: 20000\r\n\r\n' + 'x'.repeat(20000),
    'HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 2\r\n\r\nab',
    'not-http-at-all\r\n\r\n',
  ]) {
    const fixture = socketFixture([encode(wire)]);
    await assert.rejects(createTlsTransport(fixture.connect)(gatewayPost()));
    assert.equal(fixture.isClosed(), true);
  }
});

/** A socket whose far end is a gateway stand-in: the fixed HTTP/1.1 bytes in, its response out. */
function gatewaySocket(gateway: (request: Request) => Promise<Response>) {
  const writes: Uint8Array[] = [];
  let reply!: (bytes: Uint8Array) => void;
  const replied = new Promise<Uint8Array>((resolve) => (reply = resolve));
  const connect = () => ({
    opened: Promise.resolve(),
    closed: Promise.resolve(),
    readable: new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(await replied);
        controller.close();
      },
    }),
    writable: new WritableStream<Uint8Array>({
      async write(chunk) {
        writes.push(chunk.slice());
        if (writes.length < 2) return;
        const [requestLine, ...lines] = decode(writes[0]).split('\r\n').filter(Boolean);
        const headers = new Headers();
        for (const line of lines) {
          const [name, value] = line.split(': ');
          if (!['host', 'connection', 'content-length'].includes(name.toLowerCase()))
            headers.set(name, value);
        }
        const path = requestLine.split(' ')[1];
        const result = await gateway(
          new Request(`https://gateway.example${path}`, {
            method: 'POST',
            headers,
            body: writes[1],
          }),
        );
        const body = new Uint8Array(await result.arrayBuffer());
        const head = encode(
          `HTTP/1.1 ${result.status} Status\r\nContent-Type: ${result.headers.get('content-type')}\r\n` +
            `Content-Length: ${body.length}\r\n\r\n`,
        );
        const wire = new Uint8Array(head.length + body.length);
        wire.set(head);
        wire.set(body, head.length);
        reply(wire);
      },
    }),
    async close() {},
  });
  return { connect, writes };
}

test("the gateway's encrypted 503 (collector unavailable) reaches the client through the Worker transport", async () => {
  let attempts = 0;
  // Test stand-in for the separately operated gateway: decrypts, then answers an encrypted 503.
  const gateway = standInGateway(() => {
    attempts++;
    return new Response(null, { status: 503 });
  });
  const socket = gatewaySocket(gateway);
  const relay = createRelay({
    gatewayUrl: 'https://gateway.example/ohttp',
    relayAuth,
    country: () => 'GB',
    fetch: createTlsTransport(socket.connect),
  });
  const result = await FrayOhttpClient.create(publicKeys).send(
    { v: 3, kind: 'sighting' },
    { relayUrl: 'https://relay.example/ohttp', fetch: relay },
  );
  assert.equal(result.status, 503);
  assert.equal(await result.text(), '');
  assert.equal(attempts, 1);
  assert.ok(decode(socket.writes[0]).includes(`Fray-Relay-Auth: ${relayAuth}`));
});

test('passes a plain gateway 503, 429 or 403 through without its body', async () => {
  for (const status of [503, 429, 403]) {
    const fixture = socketFixture([
      encode(`HTTP/1.1 ${status} Busy\r\nContent-Length: 7\r\nRetry-After: 5\r\n\r\nprivate`),
    ]);
    const relay = createRelay({
      gatewayUrl: 'https://gateway.example/ohttp',
      relayAuth,
      fetch: createTlsTransport(fixture.connect),
    });
    const result = await relay(
      new Request('https://relay.example/ohttp', {
        method: 'POST',
        headers: { 'content-type': 'message/ohttp-req' },
        body: 'ciphertext',
      }),
    );
    assert.equal(result.status, status);
    assert.equal(await result.text(), '');
    assert.equal(result.headers.get('retry-after'), null);
  }
});

test('does not follow gateway redirects or leak Location', async () => {
  const fixture = socketFixture([
    encode('HTTP/1.1 302 Found\r\nLocation: https://attacker.example\r\nContent-Length: 0\r\n\r\n'),
  ]);
  const relay = createRelay({
    gatewayUrl: 'https://gateway.example/ohttp',
    relayAuth,
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
