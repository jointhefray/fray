# OHTTP transport profile

The transport uses [RFC 9458 Oblivious HTTP](https://www.rfc-editor.org/rfc/rfc9458.html).

## Roles

The client encrypts the sanitized report for a **receiving gateway** operated separately from the relay. A **relay** forwards the ciphertext to that gateway. The receiving service implements this transport profile, decrypts the report and submits it to a private collector.

The host must obtain informed explicit user consent before enrolling anyone in
this reporting flow; see [`protocol.md` §1.1](protocol.md#11-informed-explicit-consent-before-enrollment).
Encryption does not replace consent or remove the need to disclose the evidence,
recipients and remaining privacy limits.

With independent operators, the relay sees the client IP but not report contents; the gateway sees report contents but only the relay's connection. Running both under one operator does not establish that separation. OHTTP does not eliminate collusion, timing analysis or linkable application fields. No component should log request bodies or client-identifying headers.

## Endpoints

| Endpoint | Request | Response |
| --- | --- | --- |
| Relay `POST /ohttp` | `message/ohttp-req`, encrypted Binary HTTP request | `message/ohttp-res`, encrypted Binary HTTP response |
| Relay `GET /ohttp-keys` | No cookies or account headers | Gateway public `application/ohttp-keys` configuration |
| Gateway `POST /ohttp` | Ciphertext forwarded by relay | Encrypted response |
| Private collector `POST /v1/events` | Gateway wrapper `{ "country": "ZZ", "envelope": { ... } }` | Internal acceptance result |

`ZZ` means unknown country. The OHTTP gateway does not receive the client's IP, infer its country, or accept a client-provided country inside the report.

A relay has one configured gateway. Client paths, queries, headers and body fields cannot select another upstream. Redirects are not followed. Cookies, authorization, `Forwarded`, `X-Forwarded-For`, client user-agent strings and request IDs are not copied downstream. The response likewise has an explicit header allowlist.

The encrypted inner request targets a fixed logical report endpoint. It cannot make the gateway an arbitrary HTTP proxy. Envelopes are limited to 8064 bytes, leaving 128 bytes within the 8 KiB application-body limit for the gateway wrapper; transport overhead has its own bounded allowance. HTTP errors, oversized bodies and timeouts fail closed. No direct-to-collector fallback is permitted.

## Keys

The client needs an authentic gateway key configuration, distributed through the partner's trusted release/configuration channel. `GET /ohttp-keys` is useful for demos and updates, but accepting any key supplied by a relay would let a malicious relay substitute a key it owns. Verify or pin the expected configuration in production.

Gateway private keys belong only at the receiving gateway. Its operator must coordinate public-key rotation with authenticated client configuration updates and an overlap window for in-flight requests. The relay never receives private keys.

## Relay implementations

- [Node/TypeScript](../ohttp/typescript/): opaque relay and protocol client helper, with optional Docker for the relay.
- [Cloudflare Worker](../ohttp/cloudflare/): relay adapter. Follow its egress instructions; ordinary platform fetch behavior can add client IP headers.
- [Python](../ohttp/python/): opaque relay, with optional Docker. It uses the same receiving-gateway contract; relay code never needs gateway private keys or a crypto library.

Review the package-specific configuration and dependency notes before deployment. Relay and gateway operators must be independent to establish the stated separation of client IPs from report contents.
