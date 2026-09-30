# Example collector (Node + Redis)

The Fray-side endpoint of the [Sighting Token Protocol](../../spec/protocol.md).
Accepts gateway-wrapped sighting envelopes, verifies them, burns tokens, queues
every new creative for analyst triage, counts quorum, and auto-escalates
candidates at K. Fastify + Redis.

## Endpoints

- `POST /v1/events` — body `{ "country": "ZZ", "envelope": { ... } }` as forwarded
  by the OHTTP gateway ([envelope.md](../../spec/envelope.md)). The encrypted transport uses `ZZ` for unknown country; it does not send client IPs or infer geography. The complete wrapped body is limited to 8 KiB; larger bodies receive `413` before verification. Responds `200 {"accepted": bool, "reason": ...}` — **for debugging
  deployments only**; rejections are otherwise silent (protocol.md §6).
- `GET /healthz` — liveness + Redis reachability.

## Pipeline (protocol.md §6, in this exact order)

1. **Schema** — ajv against the normative [`../../spec/envelope.schema.json`](../../spec/envelope.schema.json)
   (copied into the Docker image at build; never a local variant).
   `additionalProperties: false` means smuggled fields — including any geo field
   a client tries to set — are rejections. A non-null creative needs only `title`;
   inferred destination fields are not accepted in either envelope version.
2. **Issuer allowlist** — `token.issuer` must be a configured partner
   (`ISSUERS="issuer.partner.example=https://issuer.partner.example,..."`).
3. **Kid window** — current or previous calendar month (UTC); older →
   `token_expired`.
4. **Signature** — JWKS fetched per issuer and cached 6h, kid-indexed;
   RSABSSA-SHA384-PSS-Deterministic verify via `@cloudflare/blindrsa-ts`.
5. **Spent-set burn** — `SET tok:<sha256(msg)hex> NX EX 6048000` (70 days,
   outliving the key window). Already present → `token_reused`, envelope dropped.
6. **Watchlist sanity** — claimed `watchlist_version` must be the local copy's
   version or the previous one (`WATCHLIST_PATH`), and `brand` must be on it.
   V2 also requires a fresh local watchlist and an `observed_domain` equal to the
   brand or one of its subdomains. Authorized brand domains are not suppressed.
7. **Quorum** — `INCR q:<brand>|<creative_hash>|<country>|<utcday>` (30-day TTL),
   `creative_hash = SHA-256(lowercase(NFC(title)))` for v1. V2 groups by displayed
   domain, advertiser identity and normalized title (or null creative), excluding
   the original lookup code and `at` value from the hash.
8. **Triage** — the first sighting of a new `(brand, creative_hash)` pushes one
   item onto the Redis list `triage` (a `seen:<brand>|<creative_hash>` NX flag
   with a 30-day TTL guarantees once). Analyst review starts here, from
   sighting one. Creative text is sanitized client-side; v2 also retains page-scoped
   lookup values that may correlate reports. Cloaked or targeted scam ads are often
   visible only to the users they target (protocol.md §6 step 7, §6.1).
9. **Candidate** — at count ≥ K=3, push one candidate JSON onto the Redis list
   `candidates` (an `NX` flag key guarantees once). K is an auto-escalation
   quorum, not a review gate: it prioritizes attention, it proves nothing.
   Independent reproduction, analyst review and case publication are operator
   responsibilities; this package supplies the queues, not those workflows.
   K distinct tokens *approximates* K distinct clients —
   enforced economically (quota × account cost), not cryptographically
   (protocol.md §7).

## What gets stored — and what never does

- **Stored:** accepted envelopes only, as `env:<sha256(msg)>` with a 90-day TTL
  (`RAW_RETENTION`, protocol.md §5); quorum counters; the spent-set; the
  triage queue; candidates. V2 reports retain advertiser details, the original
  lookup code and original `at` value, including its precise timestamp.
- **Not recorded by this pipeline:** connection IPs or request headers. In the
  intended deployment, the relay removes client-identifying headers and the
  gateway wraps the report with unknown country `ZZ`. That contract
  ([relay.md](../../spec/relay.md)) is the trust boundary; the collector cannot
  determine whether an arbitrary sender followed it. Validation rejections do
  not store an envelope; a token may already have been burned.

This is a reference implementation. Redis operations after token burning are
separate writes: a storage failure can leave partial counters/queue flags, and
the spent token cannot be retried. Watchlist authorization decisions, informed
consent and query redaction are client/host obligations; this collector does not
independently establish them from the submitted envelope.

## Run

```sh
npm ci
ISSUERS="issuer.partner.example=http://localhost:8081" npm start
# Docker (build from the repo root so /spec is in context):
docker build -f examples/collector/Dockerfile -t fray-collector-example ../..
```

Bind this example to a private network reachable only by the gateway. It is not a public ingestion service.
It has no gateway authentication of its own. Use HTTPS issuer base URLs outside
local development; the collector appends `/.well-known/jwks.json` to each configured
base. JWKS fetching is a reference cache without timeout/body bounds or
concurrent-refresh coordination; harden that client before production use.

The bundled `watchlist.sample.json` is a fictional, fixed-date fixture for the
v1 demo. It is expired and therefore cannot authorize v2 reports. For v2, set
`WATCHLIST_PATH` to a current reviewed watchlist before startup. The file is read
once at startup; restart the collector after updating it. Do not extend an old
list's expiry to keep reporting active. The v1 path checks version and brand
membership; the v2 path additionally enforces expiry and the observed-domain match.

Environment: see [.env.example](.env.example). All protocol parameters default
to the protocol.md §5 values.

## Test

```sh
docker run --rm -d -p 127.0.0.1:6379:6379 redis:7-alpine
REQUIRE_REDIS=1 REDIS_URL=redis://127.0.0.1:6379 npm test
```

The integration test creates an in-test issuer keypair, serves it from a stub
JWKS HTTP server, and plays the pipeline end-to-end: valid envelope accepted →
replay rejected (`token_reused`) → tampered signature rejected → schema
violations rejected → first sighting of a new creative pushes exactly one
triage item (and a second pushes none) → third distinct sighting of one
creative enqueues exactly one candidate. Use an isolated Redis instance: these
tests write test envelopes and queue records. `REQUIRE_REDIS=1` makes an unavailable
Redis fail the run. Without that setting, the integration suite explicitly skips
when Redis is unavailable; schema tests still run.

## License

MIT OR Apache-2.0, at your option. Copyright 2026 Marcode Ltd. See
[LICENSE-MIT](../../LICENSE-MIT) and [LICENSE-APACHE](../../LICENSE-APACHE).
