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

## Gateway access and key authentication

WAF and rate limits on the public relay do not restrict direct requests to the
gateway. If your deployment requires relay-only ingress, configure authentication
or network access controls at the gateway separately; this example does not
provide them.

Authenticate or pin gateway keys through the client's trusted configuration.
The relay's `/ohttp-keys` endpoint is not an independent source of trust. Operating
both relay and gateway under one operator does not establish the separation
described in the [privacy boundary](../README.md#deployment-boundaries).
