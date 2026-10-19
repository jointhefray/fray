# Fray

Open protocols and reference services for reporting suspected advertising fraud.
Fray lets participating clients check advertiser authorization locally, then send
eligible reports using blind-signed tokens and Oblivious HTTP (OHTTP).

[Website](https://jointhefray.org) · [Protocol](spec/protocol.md) ·
[Report format](spec/envelope.md) · [Watchlist](spec/watchlist.md) ·
[OHTTP transport](spec/relay.md)

## Components

| Component | Implementation | Purpose |
| --- | --- | --- |
| Token issuer | [TypeScript](token-issuer/typescript/) · [Python](token-issuer/python/) | Authenticate an existing account, assign it one of four issuer-defined metadata values and blind-sign its daily batch of reporting tokens. |
| OHTTP relay | [Cloudflare Worker](ohttp/cloudflare/) · [Node](ohttp/typescript/) · [Python](ohttp/python/) | Forward encrypted requests to a fixed gateway with a coarse country and device form, never client identity headers. |
| OHTTP client | [TypeScript helper](ohttp/typescript/src/client.ts) | Encrypt prepared reports and decrypt the receiving gateway's responses. |
| Authorization registry | [Cloudflare Worker](registry/cloudflare/) | Publish a validated public watchlist from a scheduled snapshot. |
| Protocol contracts | [Specifications and JSON schemas](spec/) | Define consent, report contents, token issuance, authorization rules and transport behavior. |
| Shared test material | [Issuer fixtures](token-issuer/test-fixtures/) · [Relay vectors](ohttp/test-vectors/) | TEST ONLY issuer keys and the RFC 9474 vector shared by both issuers; the relay metadata derivation table shared by all three relays. |

Each package has its own manifest and lockfile and can be built individually.
Browser ad collection, the receiving gateway and the collector are outside this
repository; the specifications define their roles. The OHTTP client helper
encrypts and sends reports; it does not extract ads or access browser sessions.
Relay and gateway operators must be independent for the OHTTP trust split to hold.

## Contract v3

- **Page reports.** Reports use envelope `v: 3`: one envelope per Google results
  page, carrying one token. A `sighting` reports the likely unauthorized ads from a
  page the user visited. A `search` reports every ad from a background search that
  a host ran for a server-chosen keyword. Both carry advertiser details, sanitized
  creatives and sanitized ad HTML, per-ad batch codes and the page's `at` value.
  Envelopes are limited to 524288 bytes and each `ad_html` to 65536 bytes.
  Versions 1 and 2 are retired.
- **Four-key tokens.** Tokens are RFC 9474 blind RSA signatures
  (`RSABSSA-SHA384-PSS-Deterministic`). Each epoch has exactly four issuer keys,
  one per two-bit metadata value that the issuer assigns to the account; the key
  that signs a token carries its value. Clients draw one fixed batch of 16 tokens
  per UTC day.
- **Relay metadata.** The relay derives the client's coarse country and device
  form from the connection and forwards only those, authenticated to the gateway
  with a shared relay secret.

See the [protocol](spec/protocol.md), [envelope contract](spec/envelope.md) and
[transport profile](spec/relay.md) for the normative rules.

## How reporting works

```text
Participating client ── authenticated blind issuance ──► partner issuer
        │
        ├── public authorization snapshot ──► registry
        │
        └── encrypted report ──► OHTTP relay ──► gateway ──► collector
                                 adds country                 ├─► sightings: operator analysis
                                 and device form              └─► searches: partner job sink
```

Every user must give informed, explicit consent before enrollment. Participation
is off by default and withdrawal stops future collection, background searches and
reporting. For a `sighting`, a client matches a watched domain, retrieves the
advertiser identity and checks the published authorization policy locally.
Authorized and inconclusive results stay local. A known advertiser absent from an
explicit complete authorization list is an investigation signal; it does not
establish fraud by itself. A `search` is not gated by the watchlist: hosts that run
background searches must disclose them before consent.

Search keywords are redacted from sighting creatives, click URLs and ad HTML while
the remaining evidence is retained. The [report contract](spec/envelope.md)
describes the precise rules, their exemptions and the correlation risks of
retained platform values, including click data with precise timestamps. OHTTP
separates network identity from report contents when its roles are independently
operated; it does not remove identifiers inside the payload. The relay-derived
country and device form, and the token's metadata value, narrow the set of clients
a report could have come from.

Issuance uses Fray's JSON profile of RFC 9474 blind RSA signatures. It is not the
RFC 9578 Privacy Pass issuance wire protocol. Issuer examples require a host
authentication implementation, a metadata assignment, persistent signing keys
generated ahead of each month and an appropriate quota store. Their explicit demo
authentication is for local testing only.

## Development

Use Node.js 24, npm, and Python 3.11 or later for the Python implementations.

```sh
npm ci
npm run setup
npm run typecheck
npm test
npm run build
npm run format:check
```

These commands cover the Node issuer, OHTTP relays and client, and registry. The
Python package READMEs document virtual environments, tests and type checks. The
cross-language issuer interoperability tests run when both issuers are installed;
see the [TypeScript issuer](token-issuer/typescript/README.md#verify). Component
READMEs also provide standalone Docker build and run commands where supported.

## Deploying the services

Follow each component's README to configure your issuer, relay or
registry. Supply the account, domains, storage and secrets for your deployment.
Relays connect to a separately operated receiving gateway using the
[OHTTP transport profile](spec/relay.md) and a relay secret that the gateway
operator accepts. The [OHTTP documentation](ohttp/) explains the trust boundaries
and key distribution requirements. Clients must authenticate gateway public keys
through a trusted release or configuration channel.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and review expectations,
[SECURITY.md](SECURITY.md) for private vulnerability reports, and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for participation expectations.

Licensed under MIT OR Apache-2.0, at your option. Copyright 2026 Marcode Ltd.
See [LICENSE-MIT](LICENSE-MIT) and [LICENSE-APACHE](LICENSE-APACHE).
