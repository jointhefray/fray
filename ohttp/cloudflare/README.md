# Cloudflare Worker relay

```sh
npm ci
npm test
npm run typecheck
npm run build       # Wrangler dry run; does not deploy
```

The example `wrangler.toml` has no production account or route. Set your account,
add a custom-domain route that you control, and replace `GATEWAY_URL` with your
receiving gateway's HTTPS `/ohttp` endpoint. `GATEWAY_KEYS_URL` is optional and must be on
the same origin. Then use `npm run dev` locally or `npm run deploy` in your own
Cloudflare account. No account credentials or secrets are stored here.

## Relay secret

The Worker needs one secret binding, never a `[vars]` entry:

```sh
openssl rand -base64 48 | npx wrangler secret put FRAY_RELAY_AUTH
```

`FRAY_RELAY_AUTH` is sent to the gateway as `Fray-Relay-Auth` (32–512
base64/base64url characters). The gateway operator must accept the same value
before the Worker starts using it. Without a valid
secret the Worker answers every route with an empty 503 and opens no socket. For
`npm run dev`, put a test-only value in `.dev.vars` (git-ignored here). Run
`npm run deploy` only after the secret exists in the account.

## Relay metadata

On `POST /ohttp` the Worker adds exactly `Fray-Country` (from `request.cf.country`,
Cloudflare's IP geolocation; `T1`, `XX`, missing or malformed → `ZZ`), `Fray-Device`
(from `Sec-CH-UA-Platform`, else `User-Agent`, else `other`) and `Fray-Relay-Auth`.
No geolocation header is trusted, and no client header, including a client-supplied
`Fray-*` header, is copied. The gateway's encrypted response, including an encrypted
503 for an unavailable collector, is relayed byte for byte; a plain gateway error
status such as 503, 429 or 403 is kept and its body dropped. The [contract](../README.md#relay-metadata) gives the
derivation rules.

## Why this uses a TLS socket

Cloudflare documents that [`fetch()` subrequests to non-Cloudflare zones can contain the client's `CF-Connecting-IP`](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip-in-worker-subrequests). Constructing a fresh `Request` and stripping incoming headers is not sufficient to make that path an oblivious relay. Workers' Node HTTP client is also [implemented through `fetch()`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/#request).

This Worker writes a small, fixed HTTP/1.1 request over [`cloudflare:sockets` with TLS enabled](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/). Only the gateway host, OHTTP media types, body length, the three relay metadata headers and ciphertext are sent. The transport validates each metadata value against its exact form and refuses to open a socket for ciphertext without them. The response is parsed using `http-parser-js`, with header and body limits and no redirect handling. TLS encryption and certificate validation belong to Cloudflare's socket implementation.

**The gateway hostname must be DNS-only and resolve outside Cloudflare's IP ranges.** Cloudflare prohibits TCP sockets to its own IP ranges. Do not put the gateway behind Cloudflare's proxy or point this Worker at another Worker. A direct TLS endpoint on another provider is the intended configuration. If this constraint does not fit your deployment, use the Node or Python relay.

The module does not log requests, and Wrangler observability is disabled. Configure account-level access logs and tracing consistently with the [OHTTP privacy boundary](../README.md#deployment-boundaries). This still trusts Cloudflare as the relay operator; TLS sockets do not prevent that operator from observing client connections or ciphertext timing.

Tests cover the exact HTTP bytes sent, metadata derivation from `request.cf`, header removal, the missing-secret refusal, fragmented/chunked responses, truncation, size limits and redirects. `src/worker.ts` holds the Worker with an injectable socket connector so workerd tests run it without network access. The dry-run build checks Worker packaging. An actual account deployment and gateway-side egress inspection remain necessary before serving users.

## Gateway access and key authentication

WAF and rate limits on the public relay do not restrict direct requests to the
gateway. `Fray-Relay-Auth` authenticates the relay to the gateway, which refuses
report submissions without a valid secret; it is not a network access control. If
your deployment requires relay-only ingress, configure network access controls at
the gateway separately; this example does not provide them.

Authenticate or pin gateway keys through the client's trusted configuration.
The relay's `/ohttp-keys` endpoint is not an independent source of trust. Operating
both relay and gateway under one operator does not establish the separation
described in the [privacy boundary](../README.md#deployment-boundaries).
