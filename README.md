# Fray

Open protocols and reference services for reporting suspected advertising fraud.
Fray lets participating clients check advertiser authorization locally, then send
eligible reports using blind-signed tokens and Oblivious HTTP (OHTTP).

[Website](https://jointhefray.org) · [Protocol](spec/protocol.md) ·
[Report format](spec/envelope.md) · [Watchlist](spec/watchlist.md)

## Components

| Component | Implementation | Purpose |
| --- | --- | --- |
| Token issuer | [TypeScript](token-issuer/typescript/) · [Python](token-issuer/python/) | Authenticate an existing account and blind-sign a quota of reporting tokens. |
| OHTTP relay | [Cloudflare Worker](ohttp/cloudflare/) · [Node](ohttp/typescript/) · [Python](ohttp/python/) | Forward encrypted requests to a fixed gateway without forwarding client identity headers. |
| OHTTP gateway | [TypeScript](ohttp/typescript/) | Decrypt reports and forward them to a private collector, or run a discard-only transport test. |
| Authorization registry | [Cloudflare Worker](registry/cloudflare/) | Publish a validated public watchlist from a scheduled snapshot. |
| Example collector | [Node and Redis](examples/collector/) | Exercise token verification, replay rejection, report validation and review grouping. |
| Protocol contracts | [Specifications and JSON schemas](spec/) | Define consent, report contents, authorization rules and transport behavior. |

This repository contains the server components, protocol contracts and test
tools. The extension collection SDK is not included in this release. The OHTTP
client helper exists to exercise the transport; it does not extract ads, access
browser sessions or implement extension collection.

The components share protocol schemas and interoperability tests, so they are
maintained in one repository. Packages have separate manifests and lockfiles and
can be built individually. Running them from one checkout does not require
deploying them together: relay and gateway operators must be independent for the
OHTTP trust split to hold.

## How reporting works

```text
Participating client ── authenticated blind issuance ──► partner issuer
        │
        ├── public authorization snapshot ──► registry
        │
        └── encrypted report ──► OHTTP relay ──► gateway ──► collector
```

Every user must give informed, explicit consent before enrollment. Participation
is off by default and withdrawal stops future collection and reporting. A client
matches a watched domain, retrieves the advertiser identity and checks the
published authorization policy locally. Authorized and inconclusive results stay
local. A known advertiser absent from an explicit complete authorization list is
an investigation signal; it does not establish fraud by itself.

Search keywords are stripped from the ad creative and click URL while the
remaining evidence is retained. The [report contract](spec/envelope.md) describes
the precise rules and the correlation risks of retained platform request values.
OHTTP separates network identity from report contents when its roles are
independently operated; it does not remove identifiers inside the payload.

Issuance uses Fray's JSON profile of RFC 9474 blind RSA signatures. It is not the
RFC 9578 Privacy Pass issuance wire protocol. Issuer examples require a host
authentication implementation, persistent signing keys and an appropriate quota
store. Their explicit demo authentication is for local testing only.

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

These commands cover the Node issuer, OHTTP services and registry. The Python
package READMEs document virtual environments, tests and type checks. Collector
integration tests require an isolated Redis instance:

```sh
REDIS_URL=redis://127.0.0.1:6379 npm run test:collector
```

The collector test command fails if Redis is unavailable; it does not silently
skip the integration tests. Do not point it at a shared or production database.

## Local interoperability demo

```sh
docker compose up --build -d
docker compose run --build --rm demo
docker compose down
```

The demo issues three tokens, sends fictional reports through the encrypted
relay/gateway path, and verifies collector triage and quorum behavior. It uses
explicit demo authentication and locally generated keys. Host ports bind to
loopback. All roles run on one machine, so the demo verifies interoperability
and does not provide the independence required for a production deployment.

## Public integration endpoints

| Role | Endpoint |
| --- | --- |
| Authorization watchlist | <https://registry.jointhefray.org/v1/watchlist.json> |
| Adpocalypse issuer discovery | <https://adpocalypse.net/.well-known/fray.json> |
| Issuer public keys | <https://adpocalypse.net/.well-known/jwks.json> |
| Authenticated issuance | `POST https://adpocalypse.net/fray/issue` |
| OHTTP relay | `POST https://ohttp.jointhefray.org/ohttp` |
| Gateway public configuration | <https://inbound.jointhefray.org/ohttp-keys> |

The public inbound currently decrypts and discards reports. Its encrypted HTTP
200 confirms transport delivery only: it does not verify or redeem tokens,
persist reports or connect to a collector. Use fictional data for integration
tests. Gateway public keys must be authenticated through a trusted release or
configuration channel, rather than accepted from an arbitrary relay.

Deployment examples contain operator placeholders. Supply your own accounts,
domains, storage and secrets before deploying. The [OHTTP documentation](ohttp/)
and component READMEs describe operational requirements and implementation limits.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and review expectations,
[SECURITY.md](SECURITY.md) for private vulnerability reports, and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for participation expectations.

Licensed under MIT OR Apache-2.0, at your option. Copyright 2026 Marcode Ltd.
See [LICENSE-MIT](LICENSE-MIT) and [LICENSE-APACHE](LICENSE-APACHE).
