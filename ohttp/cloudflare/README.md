# Cloudflare Worker relay

```sh
npm ci
npm test
npm run typecheck
npm run build       # Wrangler dry run; does not deploy
```

The example `wrangler.toml` has no production account or route. Set your account,
add a custom-domain route that you control, and replace `GATEWAY_URL` with your
gateway's HTTPS `/ohttp` endpoint. `GATEWAY_KEYS_URL` is optional and must be on
the same origin. Then use `npm run dev` locally or `npm run deploy` in your own
Cloudflare account. No account credentials are stored here.

## Why this uses a TLS socket

Cloudflare documents that [`fetch()` subrequests to non-Cloudflare zones can contain the client's `CF-Connecting-IP`](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip-in-worker-subrequests). Constructing a fresh `Request` and stripping incoming headers is not sufficient to make that path an oblivious relay. Workers' Node HTTP client is also [implemented through `fetch()`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/#request).

This Worker writes a small, fixed HTTP/1.1 request over [`cloudflare:sockets` with TLS enabled](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/). Only the gateway host, OHTTP media types, body length and ciphertext are sent. The response is parsed using `http-parser-js`, with header and body limits and no redirect handling. TLS encryption and certificate validation belong to Cloudflare's socket implementation.

**The gateway hostname must be DNS-only and resolve outside Cloudflare's IP ranges.** Cloudflare prohibits TCP sockets to its own IP ranges. Do not put the gateway behind Cloudflare's proxy or point this Worker at another Worker. A direct TLS endpoint on another provider is the intended configuration. If this constraint does not fit your deployment, use the Node or Python relay.

The module does not log requests, and Wrangler observability is disabled. Configure account-level access logs and tracing consistently with the [OHTTP privacy boundary](../README.md#deployment-boundaries). This still trusts Cloudflare as the relay operator; TLS sockets do not prevent that operator from observing client connections or ciphertext timing.

Tests cover the exact HTTP bytes sent, header removal, fragmented/chunked responses, truncation, size limits and redirects. The dry-run build checks Worker packaging. An actual account deployment and gateway-side egress inspection remain necessary before serving users.

## Initial Fray deployment

The hosted Fray relay is `https://ohttp.jointhefray.org` and forwards to
`https://inbound.jointhefray.org/ohttp` and its public key endpoint. This repository
ships operator placeholders, not that deployment's configuration. Worker
observability and preview hostnames are disabled in the example configuration.

The inbound hostname is a DNS-only CNAME to its Heroku domain, with Heroku
managed TLS. It must remain outside Cloudflare's proxy for the TLS socket
transport. The Heroku inbound service currently decrypts and discards reports;
it does not store reports or redeem tokens. Both services are controlled by
Fray in this initial rollout, so independent operation is not established.

The website at `jointhefray.org` may use Cloudflare's proxy independently. Apply
WAF/rate limits to the public report entry point, `ohttp.jointhefray.org`.
These controls do not protect direct requests to the inbound Heroku origin;
restricting that origin to authenticated relay traffic is a separate change.
The initial rollout has not configured custom WAF rules or origin authentication.

Production gateway keys must be pinned through the extension's trusted release
configuration. The relay's `/ohttp-keys` endpoint is not an independent source
of trust. The live encrypted roundtrip through the production relay and inbound
hostname passed on 30 September 2026, as did authenticated token issuance and SDK
local authorization checks. Repeat verification when changing DNS, TLS or keys.
