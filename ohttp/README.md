# Oblivious HTTP

The relay forwards encrypted reports to a separately operated receiving gateway. The gateway decrypts them and submits them to a private collector. The relay has no decryption keys; the gateway receives the relay's connection rather than the client's connection.

```
Client → Relay → Gateway → Collector
         sees IP   sees report
```

This is [RFC 9458 OHTTP](https://www.rfc-editor.org/rfc/rfc9458.html) carrying [RFC 9292 Binary HTTP](https://www.rfc-editor.org/rfc/rfc9292.html).

| Component | Implementation | Run it |
| --- | --- | --- |
| Relay | TypeScript, Node.js, Docker | [typescript](typescript/README.md) |
| Relay | Cloudflare Worker | [cloudflare](cloudflare/README.md) |
| Relay | Python, Docker | [python](python/README.md) |
| Protocol client | TypeScript class | [client.ts](typescript/src/client.ts) |

All three relays use the same HTTP contract. Choose one; they are alternatives, not a chain. Configure the relay with a receiving gateway that implements the [transport profile](../spec/relay.md). No relay needs gateway private keys.

## Contract

| Route | Method | Content |
| --- | --- | --- |
| `/ohttp` | POST | `message/ohttp-req`; successful outer response is `message/ohttp-res` |
| `/ohttp-keys` | GET | `application/ohttp-keys`, RFC length-prefixed public configurations |
| `/healthz` | GET | Process liveness only |

The relays accept at most 16 KiB of ciphertext and 4 KiB of key configuration. They reject empty submissions, unsupported media types, content encodings, query strings, and redirects. Requests and responses are bounded while reading, including chunked bodies. Timeout failures stop the request; there is no direct-collector fallback.

The only inner operation is `POST https://collector.fray.invalid/submit` with JSON. That URL is a routing identifier, never fetched. The receiving gateway must forward reports to its private collector with `{country: "ZZ", envelope: ...}`. There is deliberately no client-supplied country header. The report limit is 8064 bytes, leaving 128 bytes for the collector wrapper. The receiving service must keep collector diagnostics private: any collector HTTP 200 becomes an encrypted, empty HTTP 200 response, whether the collector accepted or dropped the report. Transport failures produce encrypted 503 responses.

## Protocol client

```ts
import { FrayOhttpClient } from './ohttp/typescript/src/client.js';

// Public keys obtained through the application's trusted configuration.
const transport = FrayOhttpClient.create(publicGatewayConfiguration);
const response = await transport.send(reportWithOneUseToken, {
  relayUrl: 'https://relay.example.org/ohttp',
});
if (!response.ok) {
  // Drop the report. Do not retry it directly against the collector.
}
```

The caller remains responsible for consent, report minimisation, token issuance and one-use token storage. The class encrypts with fresh HPKE context for every submission and decrypts the matching response. P-256, HKDF-SHA256 and AES-128-GCM are used through [`ohttp-ts`](https://github.com/thibmeu/ohttp-ts) and [`hpke`](https://github.com/panva/hpke); there is no custom HPKE implementation here.

The transport client accepts an already prepared report. Browser ad extraction
and extension integration belong to the calling application.

`FrayOhttpClient.discover(options)` obtains public keys through the relay for local demonstrations. **Authenticate or pin the gateway public configuration in production clients.** A malicious relay could substitute its own public key if it also controls unverified key discovery. Publish the same configuration to the whole client population, with a planned rotation schedule; do not issue per-user gateway keys.

## Deployment boundaries

Relay and gateway need separate, non-colluding operators for the IP/content split to provide its intended privacy benefit. Running both roles on one machine does not create that separation. A common CDN, tracing system or log pipeline can also reconnect the two sides. Neither the protocol nor these implementations prevents timing/size correlation or collusion.

Application access logging is disabled. Disable request/body capture in the surrounding proxy, runtime and monitoring configuration too. HTTPS is required outside an explicitly enabled local HTTP demo. The Cloudflare adapter uses TLS sockets because ordinary Workers `fetch()` can add the visitor's IP to outbound requests; its [README](cloudflare/README.md) explains the resulting gateway constraints.

Only the receiving gateway holds its private keys. Its operator must coordinate public-key rotation with authenticated client configuration updates and allow an overlap window for in-flight requests. Relays forward public configurations without treating them as a source of trust.

OHTTP does not prevent replay: the receiving collector must verify and spend one-use tokens. These implementations and their OHTTP dependencies have not received an independent security audit.
