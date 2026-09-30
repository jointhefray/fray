# Fray reporting protocol

How a partner extension contributes ad reports using blind-signed tokens and an encrypted relay. Advertiser lookup reports deliberately retain page-scoped request values, including a precise timestamp; these are not unlinkable payloads. The transport separates the client IP from report contents when relay and gateway are independently operated. Application data, collusion and traffic analysis remain separate considerations (§7).

This document defines the contract between participating components:

| Component     | Runs where                           | Reference implementation                                                     |
| ------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| **Issuer**    | Partner infrastructure               | [TypeScript](../token-issuer/typescript/), [Python](../token-issuer/python/) |
| **Client**    | User's browser (partner's extension) | Partner implementation following this protocol |
| **Relay**     | Partner or neutral third party       | [OHTTP adapters](../ohttp/), [`relay.md`](relay.md)                          |
| **Gateway**   | Fray infrastructure                  | [OHTTP gateway](../ohttp/typescript/)                                        |
| **Collector** | Registry infrastructure              | Operator implementation following §6                                  |

## 1. Design in one paragraph

After the user has explicitly agreed to participate, each day the client asks its **partner's own issuer** for a small batch of anonymous
tokens, using RSA blind signatures (RFC 9474). The issuer authenticates the client with
the partner's existing account machinery and enforces a quota, but — because the messages
are blinded — never sees the token values it signs. The background matches a candidate domain against a fresh watchlist, looks up the advertiser, and checks its ID against that entry’s complete authorized ID list locally. Only a known unlisted ID under a `closed`/`none` policy permits a report containing sanitized creative/details plus the original batchCode and atParameter. It attaches one unused token and encrypts the report for the **OHTTP gateway**. An independently operated **relay** forwards ciphertext without client-identifying HTTP headers. The gateway decrypts it and submits it to a private collector. The collector verifies the token against the issuer's published epoch keys
and burns it in a spent-set. A valid token proves issuance under a configured partner key. It only represents a rate-limited real account when that partner supplies real authentication and an appropriate quota store; the local mocks do not establish this property. Fresh token values do not carry an account identifier.

### 1.1 Informed explicit consent before enrollment

Every user MUST give informed, explicit consent before the partner enrolls them
in Fray. Participation is off by default. Installing an extension, granting browser
permissions, having an account, or accepting unrelated terms does not constitute
consent to Fray participation.

Before the user's affirmative choice, the partner MUST clearly explain:

- The purpose and scope of collection: watched advertising, advertiser lookups,
  the local authorization check, and reporting of likely unauthorized advertisers.
- The evidence sent: sanitized ad creative and click URLs, advertiser details,
  and original Google batch/at request values including the precise at
  timestamp. Search-query matches are redacted as specified in [`envelope.md`](envelope.md);
  this does not make the remaining evidence unlinkable.
- The recipients and roles of the partner issuer, Google lookup service, relay,
  gateway and collector, including the actual operators and whether relay and
  gateway are independently operated. Explain the IP separation that applies,
  the remaining platform/payload correlation and traffic-analysis limits, and
  accepted-report retention (90 days under this profile).
- How to withdraw. Withdrawal MUST stop future Fray collection and reporting;
  it does not recall a report already sent. Explain what happens to previously
  accepted evidence under the applicable retention policy.

The host extension or partner application owns this consent flow and must gate
Fray participation, including token issuance, collection, lookups and submissions,
on that choice. A client library does not independently verify informed consent, and a
valid blind token is not proof of it. Do not add a consent identifier, account
identifier or consent receipt to the report envelope. Material changes to the
disclosed collection or sharing require renewed informed consent before they apply.

## 2. Cryptographic suite

- **Scheme:** RFC 9474 `RSABSSA-SHA384-PSS-Deterministic`.
  - RSA-2048 minimum key size. SHA-384, MGF1-SHA-384, salt length 48 (PSS).
  - The _Deterministic_ variant (no message randomizer) is acceptable because the token
    message is already a fresh 32-byte random nonce generated client-side; it carries no
    structure for the issuer to exploit.
- **Token message:** 32 cryptographically random bytes, generated by the client, never
  reused across tokens.
- **Token:** the pair `(msg, sig)` where `sig` is the finalized (unblinded) signature
  over `msg` under the issuer's epoch key.
- **Token identifier (spent-set key):** `SHA-256(msg)`, hex-encoded.

JavaScript clients and collectors can use `@cloudflare/blindrsa-ts`
(suite `RSABSSA.SHA384.PSS.Deterministic`). Do not hand-roll the PSS encoding.

## 3. Epochs and key publication

- **Epoch = calendar month, UTC.** Key IDs are `ep-YYYY-MM` (e.g. `ep-2026-08`).
- Each issuer generates a fresh RSA-2048 keypair per epoch and publishes the **current
  and previous** epoch public keys at:

  ```
  https://{issuer-host}/.well-known/jwks.json
  ```

  An issuer may be mounted beneath a path, such as
  `https://issuer.partner.example/fray`, with its JWKS published at
  `https://issuer.partner.example/fray/.well-known/jwks.json`. Configure the
  collector with a trusted mapping from the token issuer name
  (`issuer.partner.example`) to that JWKS URL. A report cannot supply an arbitrary
  JWKS URL.

  Standard JWKS document; each key carries `kid`, `use: "sig"`, and
  `alg: "RSABSSA-SHA384-PSS-Deterministic"` (a private-use value — blind RSA has no
  registered JOSE alg).

- The collector accepts tokens whose `kid` is the current or previous epoch for that
  issuer. Anything older is rejected (`token_expired`).
- Epoch keys are the partner's public commitment: anyone can archive the JWKS and verify
  that keys actually rotate and that no per-user keys exist (a per-user key would let an
  issuer tag users; publishing exactly one key per epoch is what makes that auditable).

### 3.1 Fray issuer discovery

`/.well-known/fray.json` is the public JSON discovery convention for Fray issuers.
The reusable issuer packages expose `/issue` and `/.well-known/jwks.json`; the
host application supplies discovery when required.
It identifies `protocol: "fray-blind-rsa-v1"` and
`token_format: "fray-json-rfc9474-v1"`, with the issuer name/base URL, JWKS URL,
issuance URL, canonical watchlist URL, relay URL and direct gateway-key URL.
Gateway keys must still be pinned through a trusted release; discovery does not
authorize per-report key replacement.

Fray uses RFC 9474's blind RSA primitive with JSON nonce batches and its own token
envelope. It does not implement RFC 9578's structured Privacy Pass issuance or
RFC 9577's `PrivateToken` authentication scheme. Discovery therefore sets
`privacy_pass_compatible: false`; the standard
`/.well-known/private-token-issuer-directory` is not served as a Fray alias.

## 4. Issuance

```
POST https://{issuer-host}/issue
Authorization: (partner's existing client auth)
{ "blinded": ["<base64 blinded message>", ...] }
→ 200 { "kid": "ep-2026-08", "signatures": ["<base64 blind signature>", ...] }
→ 429 quota exceeded
```

- The client blinds each fresh 32-byte message locally, submits the batch, and finalizes
  (unblinds + verifies) each returned signature before pooling the token.
- Only users who have given informed explicit consent may participate (§1.1).
  Authentication and quota eligibility do not replace that consent.
- Issuance runs on a **daily alarm** with a **fixed batch size**, regardless of how many
  ads the user saw — issuance timing must not leak browsing activity.
- The optional issuance audit hook may record `(client-id, count, epoch, timestamp)`. Never log blinded or unblinded token values. HTTP request logging is disabled in the examples.

## 5. Parameters

| Parameter                    | Value                          | Why                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BATCH_SIZE`                 | 32 tokens/day                  | Covers heavy SERP use; small enough to bound Sybil value.                                                                                                                                                                                                                                                                                                                                         |
| `DAILY_QUOTA`                | 64 blinded messages/client/day | Batch plus one catch-up; hard 429 beyond it.                                                                                                                                                                                                                                                                                                                                                      |
| `EPOCH`                      | calendar month (UTC)           | Coarse enough that `kid` partitions users into month-sized anonymity sets only.                                                                                                                                                                                                                                                                                                                   |
| `KEY_ACCEPT_WINDOW`          | current + previous epoch       | Tolerates clients offline across rotation.                                                                                                                                                                                                                                                                                                                                                        |
| `SPENT_SET_TTL`              | 70 days                        | Outlives the acceptance window for that key; then the key is dead and the set is garbage.                                                                                                                                                                                                                                                                                                         |
| `K` (auto-escalation quorum) | 3 distinct tokens              | At K sightings of the same (brand, creative, country, day) a candidate escalates automatically. Below K, sightings sit in the analyst triage queue from the first one: cloaked and targeted scam ads are often visible only to the users they target, so a single sighting must be reviewable. Reports contain correlatable page-scoped lookup values; access and retention must reflect that. |
| `RAW_RETENTION`              | 90 days                        | Accepted envelopes; aggregates and case files persist.                                                                                                                                                                                                                                                                                                                                            |

Partners may lower `BATCH_SIZE`/`DAILY_QUOTA`; raising them above these values takes the
partner out of conformance with this profile.

## 6. Submission and verification

1. The client matches a candidate's observed domain exactly or as a subdomain
   of a fresh watchlist entry. Only displayed domains are used; authorized brand domains are not suppressed;
   brand terms and authorized aliases do not add matches. The background owns the
   persisted cache, with freshness limited to 24 hours and the document's `expires`.
   Expired or stale data cannot trigger lookup/submission. See [`watchlist.md`](watchlist.md).
2. The client looks up the Google advertiser and evaluates its ID locally using `policy` and `authorized_advertiser_ids`. Authorized identities, unknown IDs, absent authorization data and open policies are not submitted. Only a likely unauthorized identity under a complete closed/none policy can consume a reporting token. Recheck the current policy after lookup and token storage. This is an authorization signal, not proof of fraud. The client then builds a lookup envelope ([`envelope.md`](envelope.md)): sanitized
   optional creative and advertiser name/country, the observed domain, original
   batchCode and original atParameter, and an unused token. No adKey, encoded helper,
   raw response, cookies, account fields or explicit query field is copied. The at
   value deliberately retains its precise timestamp and page/request association.
   Query matches in creative text and click URLs are replaced before construction,
   preserving unrelated evidence; a matching term alone does not discard the entire
   click URL. A redacted click URL is sanitized evidence, not an exact original href.
   A non-null creative requires a title; destination domains are not inferred or sent. Envelopes are capped at 8064 bytes.
3. Client encodes the report as Binary HTTP, encrypts it for the gateway and POSTs `message/ohttp-req` to the relay at `/ohttp`. The relay forwards opaque bytes to its fixed gateway. The gateway decrypts the report and forwards `{ "country": "ZZ", "envelope": {...} }` to the private collector. `ZZ` means unknown: this OHTTP profile does not derive or transmit client geography. See [`relay.md`](relay.md) for key discovery and limits.
4. Collector, in order:
   1. Validate the lookup envelope (`v: 2`) against `envelope.schema.json`, rejecting unknown fields. Also verify a real UTC hour bucket and the 8064-byte envelope limit.
   2. Check `token.issuer` against the configured partner allowlist.
   3. Check `token.kid` is within the acceptance window; fetch/cache that issuer's JWKS.
   4. Verify `sig` over `msg` (RSABSSA verify).
   5. Burn `SHA-256(msg)` in the spent-set — atomic set-if-absent with TTL. Already
      present → reject (`token_reused`), drop the envelope.
   6. Check `brand` is on the watchlist version claimed (or a recent one). Reject an expired local watchlist and require `observed_domain` to equal `brand` or its subdomain. Membership in `authorized_domains` does not suppress that match.
   7. Accept: store the envelope (90-day retention) and increment the quorum counter for
      `(brand, creative_hash, country, UTC day)` where
      `creative_hash` uses the grouping hash below; `creative: null` is valid. The first sighting
      of a new `(brand, creative_hash)` enters the analyst **triage** queue.
   8. At count ≥ K: escalate automatically as a **candidate**.

### Grouping and persistence

The queue field `creative_hash` is
SHA-256 of the JSON array `['lookup-v2', observed_domain, identity, creative]`:

- `identity` is `['id', advertiser.id]` when an AR identifier is present; otherwise
  `['name', lowercase(NFC(name)), lowercase(NFC(country ?? ''))]`.
- `creative` is `lowercase(NFC(title))`, or `null`.

The page-scoped batchCode and atParameter are excluded from this grouping key, so
new page/request values do not split the same advertiser/creative into new review
groups. The complete accepted envelope, including both original lookup strings,
is still persisted for **90 days**. Grouping does not remove payload correlation.

### 6.1 Human review and evidence

Human review starts at the first accepted report. K is a prioritization signal, not a gate. Creative and advertiser text is sanitized before construction, and the report also carries page-scoped request values. Those values may link reports to a Google page/request and must be treated as correlatable data in analyst access, exports and retention.

Operators should attempt independent reproduction for every candidate and record
the result. Reproduction and case publication are operational responsibilities.
Successful reproduction strengthens a filing; it is not required,
because cloaking, geo-targeting, and audience targeting defeat datacenter crawlers by
design, and those campaigns are exactly the ones only users ever witness. When
reproduction fails, the filing states plainly that its evidence is sanitized
partner-contributed sightings. Publication of a case remains gated on platform
enforcement action regardless of evidence source.

Collector rejection details must stay within the receiving service. The OHTTP gateway returns a generic encrypted response and does not expose these reasons. Clients drop failed reports and never fall back to the collector directly.

## 7. What this protects against — and what it doesn't

**Protections with the required deployment:**

- An independently operated OHTTP relay sees the client network address and
  encrypted bytes, while the gateway/collector receives report contents without
  that client IP. This depends on independent operation and header handling.
- Blind signatures prevent the token's random nonce/signature from directly
  identifying the account that obtained it. Fresh tokens do not introduce an
  account identifier into a report.
- Issuance quotas limit report volume when the partner supplies real user
  authentication and durable atomic quota storage. Local auth mocks and in-memory
  example quotas do not establish those production properties.
- A fresh published watchlist limits the reporting scope. Unmatched candidates
  do not trigger lookups or reports in the configured flow.
- Host-managed informed explicit consent gates participation; withdrawal stops
  future collection and reporting. This is an integration requirement, not a
  property established by OHTTP, a blind signature or the envelope schema.

**Limits:**

- **Payload correlation is deliberate.** batchCode and atParameter are original
  Google page/request values. The at value includes a precise timestamp. A
  recipient can associate them with that page/request, and Google can correlate
  them against its records. Repeated values can connect reports. Do not describe
  reports as containing no identifiers, no precise timestamps, or no linkable data.
- OHTTP hides the client network IP from the gateway in the independent-relay
  design; it does not anonymize decrypted payload fields. It also does not hide
  the content script's advertiser lookup from Google.
- A platform can recognize its own creative.click_url parameters. Creative query
  and click-URL keyword redaction preserves unrelated evidence and does not remove
  the correlation properties of retained platform data. Redaction is not a claim
  that arbitrary opaque or encoded platform values contain no user information.
- Traffic analysis and relay/gateway collusion remain possible. A single operator
  controlling both components can associate client connections with report
  contents; this does not provide the independent-operator trust split.
- A malicious shipped extension can exfiltrate data outside this protocol. The
  partner's client code remains a trust boundary.
- K distinct tokens approximates K distinct clients; it is enforced economically
  through quotas/account cost, not cryptographically. It prioritizes investigation
  and proves neither fraud nor independent users. Publication still requires
  corroborating platform enforcement.

## 8. Wire formats

Advertiser lookup reports use envelope version `v: 2`; the published watchlist
uses format `v: 1`. These version fields identify separate contracts. A non-null
creative requires `title`, and inferred destination fields are rejected. See
[`envelope.md`](envelope.md) and [`watchlist.md`](watchlist.md) for the field rules.

Changes to field meaning, privacy properties, required fields, cryptographic
algorithms or epoch rules require a coordinated contract revision. Do not silently
reinterpret stored reports or combine incompatible grouping counters.

## References

- [RFC 9474 — RSA blind signatures](https://www.rfc-editor.org/rfc/rfc9474.html)
- [RFC 9458 — Oblivious HTTP](https://www.rfc-editor.org/rfc/rfc9458.html)
- [RFC 9292 — Binary HTTP](https://www.rfc-editor.org/rfc/rfc9292.html)
