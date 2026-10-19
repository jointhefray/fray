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
# FRAY_RELAY_AUTH comes from your secret store; never commit or log it.
GATEWAY_URL=https://gateway.example.org/ohttp FRAY_RELAY_AUTH="$FRAY_RELAY_AUTH" npm start
```

The relay listens on port 8788.

| Variable | Required | Meaning |
| --- | --- | --- |
| `GATEWAY_URL` | Yes | The gateway's HTTPS `/ohttp` endpoint, without credentials, query or fragment. |
| `FRAY_RELAY_AUTH` | Yes | Shared secret sent as `Fray-Relay-Auth`: 32–512 base64/base64url characters, e.g. `openssl rand -base64 48`. The gateway operator must accept the same value. The relay refuses to start without a valid value. |
| `FRAY_COUNTRY_HEADER` | No | Name of a header that a trusted proxy in front of the relay sets **and overwrites** on every request, such as `CF-IPCountry`. Unset → every report is `ZZ`. If clients can reach the relay without passing that proxy, leave it unset: they could choose their country. `Fray-*` names are refused. |
| `GATEWAY_KEYS_URL` | No | Overrides the public-key route; must share the gateway's origin. |
| `ALLOW_INSECURE_HTTP` | No | `true` permits HTTP upstreams for a local demonstration only. |
| `PORT` | No | Listening port (default 8788). |

The relay forwards the ciphertext with `Content-Type`, `Accept` and exactly three derived headers: `Fray-Country`, `Fray-Device` and `Fray-Relay-Auth`. See the [contract](../README.md#relay-metadata) for the derivation rules. No client header is copied.

The relay forwards bounded ciphertext and public key configurations. It does not
decrypt reports or hold gateway private keys. It passes the gateway's encrypted
response through byte for byte, including an encrypted 503 that tells the client to
retry later, and passes a plain gateway error status, such as the 403 for a
submission without a valid relay secret, through without its body. The client must
authenticate or pin the gateway's public configuration independently of the relay.

## Docker

Build from this directory. `-e NAME` without a value passes the variable from your environment, keeping secrets off the command line:

```sh
docker build -t fray-ohttp .
docker run --rm -p 8788:8788 \
  -e GATEWAY_URL=https://gateway.example.org/ohttp \
  -e FRAY_RELAY_AUTH fray-ohttp
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

## Tests

The tests that need a gateway use a test stand-in built directly on `ohttp-ts`
inside the test helpers. It decapsulates with test-only keys and returns whatever
encrypted response a test asks for; it is not a gateway implementation.
