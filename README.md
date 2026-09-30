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

Each package has its own manifest and lockfile and can be built individually.
Browser ad collection is outside this repository. The OHTTP client helper
encrypts and sends reports; it does not extract ads or access browser sessions.
Relay and gateway operators must be independent for the OHTTP trust split to hold.

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

## Deploying the services

Follow each component's README to configure your issuer, relay, gateway or
registry. Supply the account, domains, storage and secrets for your deployment.
The [OHTTP documentation](ohttp/) explains the trust boundaries and key
distribution requirements. Clients must authenticate gateway public keys through
a trusted release or configuration channel.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and review expectations,
[SECURITY.md](SECURITY.md) for private vulnerability reports, and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for participation expectations.

Licensed under MIT OR Apache-2.0, at your option. Copyright 2026 Marcode Ltd.
See [LICENSE-MIT](LICENSE-MIT) and [LICENSE-APACHE](LICENSE-APACHE).
