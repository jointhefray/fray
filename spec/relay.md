# OHTTP transport profile

The transport uses [RFC 9458 Oblivious HTTP](https://www.rfc-editor.org/rfc/rfc9458.html).

## Roles

The client encrypts the sanitized report for a **gateway**. A **relay** forwards the ciphertext to that gateway, together with a coarse country and device form that the relay derives from the client's connection. The gateway, operated separately from the relay, decrypts the report, wraps it with those two values and submits it to a private collector.

The host must obtain informed explicit user consent before enrolling anyone in
this reporting flow; see [`protocol.md` §1.1](protocol.md#11-informed-explicit-consent-before-enrollment).
Encryption does not replace consent or remove the need to disclose the evidence,
recipients and remaining privacy limits.

With independent operators, the relay sees the client IP and request headers but not report contents; the gateway sees report contents but only the relay's connection. **The relay does pass coarse client metadata to the gateway:** every report arrives with the client's country, from IP geolocation, and device form, from browser headers. These values narrow the set of clients a report could have come from ([`protocol.md` §7](protocol.md#7-what-this-protects-against--and-what-it-doesnt)). Running relay and gateway under one operator does not establish the separation; neither does running relay, gateway, collector and issuer under one operator. OHTTP does not eliminate collusion, timing analysis or linkable application fields. No component should log request bodies or client-identifying headers.

## Endpoints

| Endpoint | Request | Response |
| --- | --- | --- |
| Relay `POST /ohttp` | `message/ohttp-req`, encrypted Binary HTTP request | `message/ohttp-res`, encrypted Binary HTTP response |
| Relay `GET /ohttp-keys` | No cookies or account headers | Gateway public `application/ohttp-keys` configuration |
| Gateway `POST /ohttp` | Ciphertext forwarded by the relay, with `Fray-Country`, `Fray-Device` and `Fray-Relay-Auth` | Encrypted response |
| Private collector `POST /v1/events` | Gateway wrapper `{ "country": "GB", "device": "macos-desktop", "envelope": { ... } }`, with `Authorization: Bearer <collector token>` | Internal acceptance result |

## Relay

A relay has one configured gateway. Client paths, queries, headers and body fields cannot select another upstream. Redirects are not followed. The relay cannot read or modify the envelope.

The relay builds the gateway request from scratch. Cookies, authorization, `Forwarded`, `X-Forwarded-For` and other forwarding or tracing headers, the client IP address, the user agent, client hints, request IDs and any client-supplied `Fray-*` header are not copied downstream. On `POST /ohttp` the relay adds exactly three headers:

| Header | Value |
| --- | --- |
| `Fray-Country` | The relay-derived [country](#country). |
| `Fray-Device` | The relay-derived [device form](#device-form). |
| `Fray-Relay-Auth` | A shared secret that authenticates the relay to the gateway. It authenticates the relay, not the client. |

Key discovery requests (`GET /ohttp-keys`) carry none of these headers. The response likewise has an explicit header allowlist.

### Country

The country is the platform's IP geolocation of the client connection, as an uppercase ISO 3166-1 alpha-2 code. A Cloudflare Worker relay uses `request.cf.country`. A relay without platform geolocation may read a configured header set by a trusted front proxy, such as `CF-IPCountry`; it must do so only when that proxy overwrites any client-supplied value. A missing value, anything other than two ASCII letters, and the placeholders `T1` (Tor) and `XX` (unknown) become `ZZ`, which means unknown.

The country is derived from the client's network address. VPNs, proxies and geolocation errors can make it wrong.

### Device form

The device form is one of the seven [device values](envelope.md#device-form). The relay reads only two request headers to derive it, and forwards neither:

1. If `Sec-CH-UA-Platform` is present and its string value, without the surrounding quotes, maps as below, use that mapping:

   | `Sec-CH-UA-Platform` | Device form |
   | --- | --- |
   | `Android` | `android-mobile` |
   | `iOS` | `ios-mobile` |
   | `macOS` | `macos-desktop` |
   | `Windows` | `windows-desktop` |
   | `Linux` | `linux-desktop` |
   | `Chrome OS` or `ChromeOS` | `chromeos-desktop` |

2. Otherwise, use the first of these substrings found in `User-Agent`, checked in order: `Android` → `android-mobile`; `iPhone`, `iPad` or `iPod` → `ios-mobile`; `CrOS` → `chromeos-desktop`; `Windows NT` → `windows-desktop`; `Macintosh` or `Mac OS X` → `macos-desktop`; `Linux` → `linux-desktop`.
3. Anything else is `other`.

A browser can present a different platform from the one it runs on, so the device form is a hint. An envelope may override it ([`envelope.md`](envelope.md#device-form)); a `search` envelope always does.

## Gateway

The gateway accepts `Fray-Country` and `Fray-Device` only when `Fray-Relay-Auth` matches a configured relay secret, compared in constant time, and only in their exact forms: `^[A-Z]{2}$` and one of the seven device values. Otherwise it uses `ZZ` and `other`. A gateway may instead refuse a report submission without a valid `Fray-Relay-Auth`, with a plaintext 403 before decryption; relays pass that status through without its body. A gateway may accept several secrets to allow rotation.

The gateway then forwards `{ "country": …, "device": …, "envelope": { … } }` to its configured collector `/v1/events` endpoint with `Authorization: Bearer <collector token>`. The `device` in the wrapper is always the relay's value; the collector applies the envelope's override. Relay headers, including the relay secret, never reach the collector. A discard mode, for testing, builds and bounds the same wrapper and then drops it.

The encrypted inner request targets a fixed logical report endpoint. It cannot make the gateway an arbitrary HTTP proxy. A report the collector processed, accepted or rejected, receives the same encrypted HTTP 200, and an invalid inner request receives it too; rejection reasons never reach clients or relays. A gateway in forwarding mode that cannot reach the collector returns an encrypted 503, after which the client may resend the same envelope and token through the relay later. If the collector had already accepted it, the resend is dropped as a reused token. No direct-to-collector fallback is permitted.

## Limits

| Limit | Bytes | Enforced by |
| --- | --- | --- |
| Envelope, serialized UTF-8 | 524288 | Client before encryption; gateway after decryption; collector |
| Each `ad_html` string | 65536 | Client; collector |
| Encapsulated request (ciphertext) | 655360 | Relay and gateway, while reading |
| Wrapper sent to the collector | 532480 | Gateway; collector |

HTTP errors, oversized bodies and timeouts fail closed. See [`envelope.md`](envelope.md#size) for how a client keeps an envelope within its limit.

## Keys

The client needs an authentic gateway key configuration, distributed through the partner's trusted release/configuration channel. `GET /ohttp-keys` is useful for demos and updates, but accepting any key supplied by a relay would let a malicious relay substitute a key it owns. Verify or pin the expected configuration in production.

Gateway private keys belong only at the gateway. Persist them across restarts; do not bake them into images or commit them. Rotation needs a coordinated client configuration update and an overlap window for in-flight requests. The gateway accepts multiple configured keys for that purpose.

The relay secret and the collector bearer token are shared secrets between operators. Keep them out of source control and logs, and rotate them with an overlap window.

## Relay implementations

- [Node/TypeScript](../ohttp/typescript/): opaque relay and protocol client helper, with optional Docker for the relay.
- [Cloudflare Worker](../ohttp/cloudflare/): relay adapter. Follow its egress instructions; ordinary platform fetch behavior can add client IP headers.
- [Python](../ohttp/python/): opaque relay, with optional Docker. It uses the same receiving-gateway contract; relay code never needs gateway private keys or a crypto library.

Review the package-specific configuration and dependency notes before deployment. Relay and gateway operators must be independent to establish the stated separation of client IPs from report contents. Independence does not remove the country and device form the relay forwards.
