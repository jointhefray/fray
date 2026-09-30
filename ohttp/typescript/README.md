# Node OHTTP relay and client

Requires Node.js 24; the Docker image uses Node.js 24. Install and check:

```sh
npm ci
npm test
npm run build
```

## Relay

Configure a separately operated receiving gateway that implements the
[OHTTP transport profile](../../spec/relay.md):

```sh
GATEWAY_URL=https://gateway.example.org/ohttp npm start
```

The relay listens on port 8788. `GATEWAY_KEYS_URL` optionally overrides the public-key route, but must use the same origin as `GATEWAY_URL`. Both URLs must be HTTPS, without credentials, query strings or fragments. `ALLOW_INSECURE_HTTP=true` permits HTTP for local testing only. `PORT` overrides the listening port.

The relay forwards bounded ciphertext and public key configurations. It does not
decrypt reports or hold gateway private keys. The client must authenticate or pin
the gateway's public configuration independently of the relay.

## Docker

Build from this directory:

```sh
docker build -t fray-ohttp .
docker run --rm -p 8788:8788 \
  -e GATEWAY_URL=https://gateway.example.org/ohttp fray-ohttp
```

The relay runs as the unprivileged `node` user. Configure access controls and
disable request/body capture in the surrounding hosting and proxy systems.

## Protocol client

[`FrayOhttpClient`](src/client.ts) encrypts a prepared report using authenticated
gateway public keys, sends the ciphertext through a relay, and decrypts the
matching response. The calling application supplies consent, report construction,
sanitization and one-use token handling.

See the [OHTTP overview](../README.md#protocol-client) for the client API and
the [deployment boundaries](../README.md#deployment-boundaries) for key
authentication and operator separation.
