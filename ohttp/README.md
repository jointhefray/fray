# Oblivious HTTP

The relay forwards encrypted reports to a separately operated receiving gateway. The gateway decrypts them and submits them to a private collector. The relay has no decryption keys; the gateway receives the relay's connection rather than the client's connection. The relay also derives two coarse values from the client connection, country and device form, and passes only those to the gateway.

```
Client → Relay ──────────────→ Gateway ─────────────→ Collector
         sees IP, derives        sees report, country   { country, device, envelope }
         country + device form   and device form
```

This is [RFC 9458 OHTTP](https://www.rfc-editor.org/rfc/rfc9458.html) carrying [RFC 9292 Binary HTTP](https://www.rfc-editor.org/rfc/rfc9292.html).

| Component | Implementation | Run it |
| --- | --- | --- |
| Relay | TypeScript, Node.js, Docker | [typescript](typescript/README.md) |
| Relay | Cloudflare Worker | [cloudflare](cloudflare/README.md) |
| Relay | Python, Docker | [python](python/README.md) |
| Protocol client | TypeScript class | [client.ts](typescript/src/client.ts) |

All three relays use the same HTTP contract. Choose one; they are alternatives, not a chain. Configure the relay with a receiving gateway that implements the [transport profile](../spec/relay.md). No relay needs gateway private keys or a decryption library. The gateway is operated separately and is not part of this repository.

## Contract

| Route | Method | Content |
| --- | --- | --- |
| `/ohttp` | POST | `message/ohttp-req`; successful outer response is `message/ohttp-res` |
| `/ohttp-keys` | GET | `application/ohttp-keys`, RFC length-prefixed public configurations |
| `/healthz` | GET | Process liveness only |

| Limit | Bytes | Enforced by |
| --- | --- | --- |
| Envelope (serialized UTF-8 inner request body) | 524288 | Client before encryption; gateway after decryption |
| Encapsulated request (ciphertext) | 655360 | Relay and gateway, while reading |
| Wrapper sent to the collector | 532480 | Gateway |
| Encrypted response | 16384 | Client and relay |
| Key configuration | 4096 | Client and relay |

The relays reject empty submissions, unsupported media types, content encodings, query strings, and redirects. Requests and responses are bounded while reading, including chunked bodies. Timeout failures stop the request; there is no direct-collector fallback.

The only inner operation is `POST https://collector.fray.invalid/submit` with JSON. That URL is a routing identifier, never fetched. The client adds no metadata to it: geography and device form never appear in an envelope or client header.

### Relay metadata

Every relay builds the gateway request from scratch. Cookies, authorization, forwarding and tracing headers, the IP address, the user agent, client hints and any client-supplied `Fray-*` header are never copied. On `POST /ohttp` it adds exactly three headers:

| Header | Value |
| --- | --- |
| `Fray-Country` | Uppercase ISO 3166-1 alpha-2 from the platform's IP geolocation: Cloudflare `request.cf.country`, or for Node and Python the header named by `FRAY_COUNTRY_HEADER`. Unset, `T1`, `XX`, missing or malformed → `ZZ`. |
| `Fray-Device` | `Sec-CH-UA-Platform` when it maps: `Android`→`android-mobile`, `iOS`→`ios-mobile`, `macOS`→`macos-desktop`, `Windows`→`windows-desktop`, `Linux`→`linux-desktop`, `Chrome OS`/`ChromeOS`→`chromeos-desktop`. Otherwise the first `User-Agent` substring match, in order: `Android`, `iPhone`/`iPad`/`iPod`, `CrOS`, `Windows NT`, `Macintosh`/`Mac OS X`, `Linux`. Else `other`. |
| `Fray-Relay-Auth` | The relay's shared secret, `FRAY_RELAY_AUTH`. |

A relay without a valid `FRAY_RELAY_AUTH` (32–512 base64/base64url characters) refuses to start; the Cloudflare Worker answers 503 and forwards nothing. Key discovery requests carry none of these headers. [`test-vectors/relay-metadata.json`](test-vectors/relay-metadata.json) is the shared derivation table all three relays are tested against.

### Gateway responses

The receiving gateway's behavior is defined by the [transport profile](../spec/relay.md#gateway). What a client and relay see:

| Response | Meaning |
| --- | --- |
| Encrypted 200 | The gateway decrypted the report. It does not say whether the collector accepted it: rejection reasons never reach clients or relays. |
| Encrypted 503 | The collector was unavailable. The client may retry later through the relay with the same envelope and token; if the collector had already accepted it, the retry is dropped as a reused token. |
| Plaintext 403 | The submission did not carry a valid relay secret and was refused before decryption. |
| Plaintext 4xx | The gateway could not decrypt the request. |

Relays pass the encrypted response through byte for byte, and pass a plain gateway error status such as 503, 429 or 403 through without its body.

## Protocol client

```ts
import { FrayOhttpClient } from './ohttp/typescript/src/client.js';

// Public keys obtained through the application's trusted configuration.
const transport = FrayOhttpClient.create(publicGatewayConfiguration);
const response = await transport.send(reportWithOneUseToken, {
  relayUrl: 'https://relay.example.org/ohttp',
});
if (response.status === 503) {
  // Collector unavailable: retry later through the relay with the same envelope and token.
}
// 200 means the gateway decrypted the report, not that the collector accepted it.
// Relay or gateway transport failures throw. Never send a report directly to the collector.
```

The caller remains responsible for consent, report minimisation, token issuance and one-use token storage. `send` refuses an envelope whose serialized UTF-8 form exceeds 524288 bytes before any network request. The class encrypts with fresh HPKE context for every submission and decrypts the matching response. P-256, HKDF-SHA256 and AES-128-GCM are used through [`ohttp-ts`](https://github.com/thibmeu/ohttp-ts) and [`hpke`](https://github.com/panva/hpke); there is no custom HPKE implementation here.

The transport client accepts an already prepared report. Browser ad extraction
and extension integration belong to the calling application.

`FrayOhttpClient.discover(options)` obtains public keys through the relay for local demonstrations. **Authenticate or pin the gateway public configuration in production clients.** A malicious relay could substitute its own public key if it also controls unverified key discovery. Publish the same configuration to the whole client population, with a planned rotation schedule; do not issue per-user gateway keys.

## Deployment boundaries

Relay and gateway need separate, non-colluding operators for the IP/content split to provide its intended privacy benefit. Running both roles on one machine, or under one operator, does not create that separation. The relay-derived country and device form reach the gateway and the collector by design; they are coarse, but they narrow the population a report can come from. A common CDN, tracing system or log pipeline can also reconnect the two sides. Neither the protocol nor these implementations prevents timing/size correlation or collusion.

Application access logging is disabled. Disable request/body capture in the surrounding proxy, runtime and monitoring configuration too. HTTPS is required outside an explicitly enabled local HTTP demo. The Cloudflare adapter uses TLS sockets because ordinary Workers `fetch()` can add the visitor's IP to outbound requests; its [README](cloudflare/README.md) explains the resulting gateway constraints.

The relay secret authenticates the relay to the gateway, not the client. It is not a network access control for the gateway. Store `FRAY_RELAY_AUTH` as a platform secret, never in files or images. To rotate it, have the gateway accept both the old and the new value, switch the relay's `FRAY_RELAY_AUTH`, then retire the old value at the gateway.

Only the receiving gateway holds its private keys. Its operator must coordinate public-key rotation with authenticated client configuration updates and allow an overlap window for in-flight requests. Relays forward public configurations without treating them as a source of trust.

OHTTP does not prevent replay: the receiving collector must verify and spend one-use tokens. These implementations and their OHTTP dependencies have not received an independent security audit. Tests exercise ciphertext round trips through a test stand-in for the gateway, a published RFC vector, forwarding boundaries, metadata derivation, malformed input, limits, and timeouts; they are not a deployment audit.
