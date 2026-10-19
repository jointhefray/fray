# Fray reporting protocol

How a partner extension contributes ad reports using blind-signed tokens and an encrypted relay. Reports deliberately retain page-scoped request values and the platform's ad markup and click data, including precise timestamps; these are not unlinkable payloads. The relay adds the client's coarse country and device form. The transport separates the client IP from report contents when relay and gateway are independently operated. Application data, collusion and traffic analysis remain separate considerations (§7).

This document defines the contract between participating components:

| Component     | Runs where                           | Reference implementation                                                     |
| ------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| **Issuer**    | Partner infrastructure               | [TypeScript](../token-issuer/typescript/), [Python](../token-issuer/python/) |
| **Client**    | User's browser (partner's extension) | Partner implementation following this protocol |
| **Relay**     | Partner or neutral third party       | [OHTTP adapters](../ohttp/), [`relay.md`](relay.md)                          |
| **Gateway**   | Receiving service, operated separately from the relay | Operator implementation following [the OHTTP transport profile](relay.md) |
| **Collector** | Registry infrastructure              | Operator implementation following §6                                  |
| **Job sink**  | Issuing partner's infrastructure, only for hosts that run background searches | Host-specific; receives `search` results (§6.2) |

## 1. Design in one paragraph

After the user has explicitly agreed to participate, the client asks its **partner's own issuer** once per UTC day, on a fixed schedule, for a fixed batch of tokens, using RSA blind signatures (RFC 9474). Each epoch has exactly four issuer keys, one per public metadata value, and the key that signs a token shows which of the four values the issuer assigned to the account (§4.1). The issuer authenticates the client with
the partner's existing account machinery and enforces a quota, but — because the messages
are blinded — never sees the token values it signs. For a passive **`sighting`**, the background matches each ad's displayed domain against a fresh watchlist, looks up the advertiser, and checks its ID against that entry's complete authorized ID list locally. Only ads with a known unlisted ID under a `closed`/`none` policy are reported: the qualifying ads from one results page go into one envelope containing their sanitized creatives, ad HTML and advertiser details, each ad's original batch code and the page's original atParameter. A host that runs server-issued background searches may also submit one **`search`** envelope per results page, listing every ad on it (§6.2). Each envelope carries one unused token and is encrypted for the **OHTTP gateway**. A **relay** forwards the ciphertext without client-identifying HTTP headers, adding only a coarse country and device form it derives from the connection. The gateway decrypts the report and submits it to a private collector. The collector verifies the token against the issuer's published epoch keys
and burns it in a spent-set, then delivers accepted sightings to the operator's analysis systems and search results to the issuing partner's job sink. A valid token proves issuance under a configured partner key. It only represents a rate-limited real account when that partner supplies real authentication and an appropriate quota store; the local mocks do not establish this property. Fresh token values do not carry an account identifier.

### 1.1 Informed explicit consent before enrollment

Every user MUST give informed, explicit consent before the partner enrolls them
in Fray. Participation is off by default. Installing an extension, granting browser
permissions, having an account, or accepting unrelated terms does not constitute
consent to Fray participation.

Before the user's affirmative choice, the partner MUST clearly explain:

- The purpose and scope of collection: watched advertising, advertiser lookups,
  the local authorization check, reporting of likely unauthorized advertisers and,
  for hosts that run them, background searches.
- The evidence sent: sanitized ad creative, click URLs and ad HTML; the platform's
  ad identifiers; advertiser details; original Google batch/at request values
  including the precise at timestamp; and the platform click data kept in click
  URLs and ad HTML, including `gclid` values with precise click timestamps.
  Reports can also include the platform's "why this ad" targeting reason codes:
  categories such as age or location interests that the platform says the
  advertiser used to reach the user, plus codes for the source of each signal,
  not the values. Unless the partner has enabled sending the
  passive search query, search-query matches are redacted from sightings as specified in
  [`envelope.md`](envelope.md), except where query terms coincide with the
  reported brand or domain, which recipients may then see. Redaction does not make
  the remaining evidence unlinkable.
- When the partner has enabled sending the passive search query: that the user's
  search query is sent with each report.
- The client metadata sent with every report: the client's country, from IP
  geolocation, and device form, from browser headers, both derived by the relay.
- That each token carries a value the issuer assigns to the account, one of four,
  whose meaning the issuer defines and does not publish, and that this value can
  determine whether a report is used (§4.1).
- For hosts that run background searches (§6.2): the keywords are chosen by the
  job issuer's server, not the user; the searches are made from the user's browser,
  in the user's browser session, so the platform receives them as that browser's
  traffic; every ad on each results page is reported together with the unredacted
  keyword; and results reach the job issuer without account credentials or an
  account identifier, but the job issuer knows which account polled which job at
  assignment time and can correlate results with assignments (§7).
- The recipients and roles of the partner issuer, Google lookup service, relay,
  gateway, collector, the operator's analysis systems and, for background search,
  the issuing partner's job sink, including the actual operators and whether
  relay, gateway, collector and issuer are independently operated. Explain the IP
  separation that applies, the client metadata the relay forwards, the remaining
  platform/payload correlation and traffic-analysis limits, accepted-report
  retention at the collector (90 days under this profile), and that copies
  delivered to the operator's analysis systems and to a job sink are retained
  under those recipients' own policies, which this profile does not set.
- How to withdraw. Withdrawal MUST stop future Fray collection and reporting,
  including background searches and submissions still waiting out their delay; it
  stops issuance and deletes the client's unspent tokens. It does not recall a
  report already sent. Explain what happens to previously accepted evidence under
  the applicable retention policy.

The host extension or partner application owns this consent flow and must gate
Fray participation, including token issuance, collection, lookups, background
searches and submissions, on that choice. A host may offer separate controls for
passive reporting and background search; turning both off is withdrawal. A client
library does not independently verify informed consent, and a
valid token is not proof of it. Do not add a consent identifier, account
identifier or consent receipt to the report envelope. Material changes to the
disclosed collection or sharing require renewed informed consent before they apply.

## 2. Cryptographic suite

- **Scheme:** RFC 9474 `RSABSSA-SHA384-PSS-Deterministic`.
  - Standard RSA-2048 keys (minimum size) with public exponent e = 65537. SHA-384,
    MGF1-SHA-384, salt length 48 (PSS).
  - The _Deterministic_ variant (no message randomizer) is acceptable because the token
    message is already a fresh 32-byte random nonce generated client-side; it carries no
    structure for the issuer to exploit.
  - **Fault protection.** An issuer MUST verify each blind signature it produces before
    returning it, to defend against RSA-CRT fault attacks. It may do so explicitly
    (`s^e mod n` must equal the blinded message) or rely on an RSA implementation that
    performs that check inside the private operation; OpenSSL does. Checking twice
    roughly doubles issuer cost and adds no protection.
- **Public metadata:** `meta`, an integer from 0 to 3 (2 bits) that the issuer assigns
  (§4.1). It is carried by which key signs: each epoch has exactly four keys, one per
  value (§3). A signature made with one value's key does not verify under another
  value's key, so neither the client nor anyone else can change a token's value.
- **Token message:** 32 cryptographically random bytes, generated by the client, never
  reused across tokens.
- **Token:** `(kid, meta, msg, sig)`, where `kid` is the epoch ID `ep-YYYY-MM` and `sig`
  is the finalized (unblinded) signature over `msg` under the issuer's key `kid.meta`.
- **Token identifier (spent-set key):** `SHA-256(msg)`, hex-encoded.

JavaScript clients and collectors can use `@cloudflare/blindrsa-ts`
(suite `RSABSSA.SHA384.PSS.Deterministic`). Do not hand-roll the PSS encoding.

## 3. Epochs and key publication

- **Epoch = calendar month, UTC.** Epoch IDs are `ep-YYYY-MM` (e.g. `ep-2026-08`).
  Each epoch has exactly four keys, one per metadata value N = 0–3, with JWK `kid`
  `ep-YYYY-MM.N` (e.g. `ep-2026-08.2`).
- Each issuer generates four fresh RSA-2048 keypairs per epoch and publishes the
  **current and previous** epochs' public keys, eight in all, at:

  ```
  https://{issuer-host}/.well-known/jwks.json
  ```

  An issuer may be mounted beneath a path, such as
  `https://issuer.partner.example/fray`, with its JWKS published at
  `https://issuer.partner.example/fray/.well-known/jwks.json`. Configure the
  collector with a trusted mapping from the token issuer name
  (`issuer.partner.example`) to that JWKS URL. A report cannot supply an arbitrary
  JWKS URL.

  Standard JWKS document; each key carries `kid` (`ep-YYYY-MM.N`), `use: "sig"`, and
  `alg: "RSABSSA-SHA384-PSS-Deterministic"` (a private-use value — blind RSA has no
  registered JOSE alg).

- The JWKS is public. Clients and collectors fetch it **without authentication**: no
  credentials, cookies or account headers. The issuer MUST serve the same document to
  every requester.

- The collector accepts tokens whose `kid` is the current or previous epoch for that
  issuer. Anything older is rejected (`token_expired`).
- **Key consistency.** An issuer publishes **exactly four** public keys per epoch,
  labelled `.0` to `.3`, and serves the same keys to everyone. Any other number of keys
  for an epoch, or keys served differently to different requesters, violates this
  profile, and anyone can detect it from archived JWKS documents. Epoch keys are the
  partner's public commitment: anyone can archive the JWKS and verify that keys
  actually rotate, that each epoch has exactly four, and that no per-user keys exist (a
  per-user key would let an issuer tag users; a fixed, public set of four per epoch is
  what makes that auditable). The four keys are the four metadata values and nothing
  more (§4.1).
- Clients and the collector refuse an epoch that does not publish exactly four keys:
  clients do not request or verify tokens for it, and the collector rejects tokens
  claiming it.

### 3.1 Fray issuer discovery

`/.well-known/fray.json` is the public JSON discovery convention for Fray issuers.
An issuer serves `/meta`, `/issue` and `/.well-known/jwks.json` (§3, §4); the
host application supplies discovery when required.
It identifies `protocol: "fray-blind-rsa-v2"`,
`token_format: "fray-json-rfc9474-v2"` and `metadata_bits: 2`, with the issuer
name/base URL, JWKS URL, issuance URL, canonical watchlist URL, relay URL and direct
gateway-key URL.
Gateway keys must still be pinned through a trusted release; discovery does not
authorize per-report key replacement.

Fray uses RFC 9474's blind RSA primitive with JSON nonce batches, four keys per
epoch and its own token envelope. It does not implement RFC 9578's structured Privacy Pass issuance or
RFC 9577's `PrivateToken` authentication scheme. Discovery therefore sets
`privacy_pass_compatible: false`; the standard
`/.well-known/private-token-issuer-directory` is not served as a Fray alias.

## 4. Issuance

```
GET https://{issuer-host}/meta
Authorization: (partner's existing client auth)
→ 200 { "meta": 2 }                      Cache-Control: no-store

POST https://{issuer-host}/issue
Authorization: (partner's existing client auth)
{ "meta": 2, "blinded": ["<base64 blinded message>", ...] }
→ 200 { "kid": "ep-2026-08.2", "signatures": ["<base64 blind signature>", ...] }
→ 409 { "error": "meta_mismatch" }       meta is not the account's current value; no quota consumed
→ 429 quota exceeded
→ 503 temporarily unavailable; try again later
```

- The client fetches its current metadata value `n` from `/meta`, blinds each fresh
  32-byte message locally with the current epoch's key for `n` (JWK `kid`
  `ep-YYYY-MM.n`), and submits the batch with `n`. The issuer signs with key `n`. The
  response's `kid` names the signing key (`ep-YYYY-MM.n`); the client checks it is the key
  it blinded with, finalizes (unblinds + verifies) each returned signature with that key
  and stores the epoch ID and `n` with each token before pooling it. The envelope's `token.kid`
  and `token.meta` carry those values, and a verifier uses key `kid.meta`.
- On `409 meta_mismatch` the client refetches `/meta` once, blinds again with the key
  for the new value and repeats the request. It does not retry a mismatch further. A mismatch
  consumes no quota.
- Only users who have given informed explicit consent may participate (§1.1).
  Authentication and quota eligibility do not replace that consent.
- Issuance runs on a **fixed daily alarm**: one request per UTC day for a **fixed
  batch of 16** blinded messages, regardless of how many ads the user saw or how
  many background searches the host ran. Seeing an ad or finishing a search never
  triggers issuance, and there is no catch-up or top-up request. Issuance timing
  and size must not leak browsing activity. A client holds at most 64 unspent
  tokens, shared by both report kinds; unused tokens carry over within their epoch
  window, so a busy day can draw on earlier batches.
- The first issuance after enrolment, or after an extension update, may run at a
  uniformly random time within about an hour; issuance then follows the fixed daily
  alarm. That timing is tied to enrolment or the update, not to browsing, so it
  reveals no ad activity. The issuer does learn roughly when the client enrolled or
  was updated.
- Withdrawal stops issuance and deletes the client's unspent tokens.
- The optional issuance audit hook may record `(client-id, count, epoch, timestamp)`. Never log blinded or unblinded token values. HTTP request logging is disabled in the examples.

### 4.1 Issuer metadata

Each token carries exactly **two bits** of issuer-assigned metadata, in total. The
complete set of metadata values is **0, 1, 2 and 3**. There is no other metadata field,
no longer encoding and no extension mechanism. The schema rejects any other value, and
the protocol offers no second channel through which an issuer could attach more.

The limit is deliberate. Two bits can describe at most four groups of accounts, which
is too few to carry an identifier, so the metadata cannot be used to single out a user.
It is enough for up to two yes/no properties of an account, or one property with up
to four levels.

An issuer assigns each account one of the four values and defines what they mean; the
meaning is not published. The client learns its value from `/meta`, the value selects
which of the epoch's four keys signs each token (§2), and every envelope carries it
openly in `token.meta`. The four values correspond one-to-one to the four keys published
for each epoch (§3), so an auditor can confirm the two-bit limit from the JWKS alone.

- An account's value MUST change at most once per epoch.
- The value MUST NOT encode account identity, a timestamp (such as an issuance, request
  or account-creation time) or browsing activity. Each value describes a coarse property
  shared by many accounts.
- The collector verifies each token with the key for the `meta` value it claims
  (`kid.meta`). The operator
  configures which values it accepts for each issuer. A report whose value is not
  accepted is discarded after its token is burned: the envelope is not stored,
  counted or delivered, and nothing visible to the client differs from an accepted
  report.

**Privacy consequence.** Metadata splits the reports from one issuer into at most four
groups per epoch. Combined with the relay's country and device form, that narrows the
set of clients a report could have come from. The client can see its own value; it
cannot learn from the protocol what the value means or whether a report was used.
These constraints are obligations on the issuer: the protocol bounds the number of
values and makes them visible in every token and in the JWKS, but it cannot verify
what an issuer encodes in them.

## 5. Parameters

| Parameter | Value | Why |
| --- | --- | --- |
| `BATCH_SIZE` | 16 tokens/day | One token per reported results page, for sightings and background searches together. Small enough to keep issuer cost low (one RSA private operation per token) and to bound Sybil value. |
| `DAILY_QUOTA` | 16 blinded messages/client/day | One batch, no catch-up; hard 429 beyond it. |
| `POOL_CAP` | 64 unspent tokens/client | Unused tokens carry over within the key acceptance window; issuance beyond the cap is discarded by the client. |
| `METADATA_BITS` | 2 (values 0–3, no others) | Fixed by design, not a partner option: two bits allow at most four groups per issuer per epoch, too few to carry an identifier (§4.1). |
| `KEYS_PER_EPOCH` | 4 (JWK `kid` `ep-YYYY-MM.0` to `.3`) | One key per metadata value. Any other number violates the profile and is detectable from archived JWKS; clients and the collector refuse such an epoch (§3). |
| `METADATA_CHANGES` | at most 1 per account per epoch | Bounds how often an account's metadata partition can change (§4.1). |
| `EPOCH` | calendar month (UTC) | Coarse enough that `kid` partitions users into month-sized anonymity sets only. |
| `KEY_ACCEPT_WINDOW` | current + previous epoch | Tolerates clients offline across rotation. |
| `SPENT_SET_TTL` | 70 days | Outlives the acceptance window for that key; then the key is dead and the set is garbage. |
| `SEARCH_SUBMIT_DELAY` | uniformly random, 60–900 s | Separates a `search` submission from search completion so arrival time alone does not match a result to its assignment. It does not prevent correlation (§7). |
| `ENVELOPE_MAX_BYTES` | 524288 | Complete serialized UTF-8 envelope. Clients null `ad_html` values, largest first, to fit ([`envelope.md`](envelope.md#size)). |
| `AD_HTML_MAX_BYTES` | 65536 | Each `ad_html` string, as UTF-8 bytes. |
| `K` (auto-escalation quorum) | 3 distinct tokens | At K sightings of the same (brand, grouping hash, country, day) a candidate escalates automatically. Below K, sightings sit in the analyst triage queue from the first one: cloaked and targeted scam ads are often visible only to the users they target, so a single sighting must be reviewable. Reports contain correlatable page-scoped lookup values and platform click data; access and retention must reflect that. |
| `RAW_RETENTION` | 90 days | Accepted envelopes at the collector; aggregates and case files persist. |

Partners may lower `BATCH_SIZE`/`DAILY_QUOTA`; raising them above these values takes the
partner out of conformance with this profile. Transport limits are in
[`relay.md`](relay.md#limits).

## 6. Submission and verification

1. **`sighting`:** the client matches each ad's observed domain exactly or as a subdomain
   of a fresh watchlist entry. Only displayed domains are used; authorized brand domains are not suppressed;
   brand terms and authorized aliases do not add matches. The background owns the
   persisted cache, with freshness limited to 24 hours and the document's `expires`.
   Expired or stale data cannot trigger lookup/submission. See [`watchlist.md`](watchlist.md).
2. **`sighting`:** the client looks up each matched ad's Google advertiser and evaluates its ID locally using `policy` and `authorized_advertiser_ids`. Authorized identities, unknown IDs, absent authorization data and open policies are not submitted. Only likely unauthorized identities under a complete closed/none policy are reported. If no ad on the page qualifies, nothing is sent and no token is consumed. Recheck the current policy after lookup and token storage. This is an authorization signal, not proof of fraud. The client then builds one envelope for the page's qualifying ads ([`envelope.md`](envelope.md)): per ad, the observed domain, matched brand, sanitized
   optional creative, advertiser name/country and optional targeting reason codes, original batch code, optional `ad_id` and sanitized `ad_html`; per page, the original atParameter and one unused token. No adKey, encoded helper,
   raw response, cookies, account fields or explicit query field is copied, except
   the partner opt-in `keyword` below. The at
   value deliberately retains its precise timestamp and page/request association.
   Query matches in creative text, click URLs and ad HTML are replaced before construction,
   preserving unrelated evidence; a matching term alone does not discard the entire
   click URL. Terms that coincide with the ad's observed domain or brand are not
   redacted. A redacted click URL is sanitized evidence, not an exact original href.
   A non-null creative requires a title; destination domains are not inferred or sent. Envelopes are capped at 524288 bytes and each `ad_html` at 65536 bytes.

   **Passive query (partner opt-in).** By default the client redacts the query and
   sends none. A partner may opt in to sending it: the sighting then carries
   `keyword`, the page's search query, NFC-normalized and trimmed, 1–200 characters,
   and omits it otherwise. Creative and `ad_html` redaction is unchanged either way.

   **`search`:** see §6.2.
3. The client encodes the report as Binary HTTP, encrypts it for the gateway and POSTs `message/ohttp-req` to the relay at `/ohttp`. The relay derives the client's country and device form from the connection and forwards the opaque bytes to its fixed gateway with only `Fray-Country`, `Fray-Device` and `Fray-Relay-Auth`. The gateway decrypts the report and forwards `{ "country": "GB", "device": "macos-desktop", "envelope": {...} }` to the private collector with a bearer token. It uses the relay's values only with valid relay authentication, and `ZZ` (unknown) and `other` otherwise. See [`relay.md`](relay.md) for derivation, key discovery and limits.
4. Collector, in order:
   1. **Wrapper.** `country` matches `^[A-Z]{2}$`, `device` is one of the
      [device values](envelope.md#device-form), and the body is at most 532480 bytes.
   2. **Envelope.** Validate against `envelope.schema.json` (`v: 3`), rejecting
      unknown fields, and verify that `observed_hour` is a real UTC hour. Check
      the byte limits (524288 per envelope, 65536 per `ad_html`) and repeat the
      final `ad_html` safety checks ([`envelope.md`](envelope.md#ad_html-sanitization),
      step 5). A `sighting` carrying `keyword` is accepted only from an issuer the
      operator has configured to send it. A failure here rejects the envelope
      before any token work.
   3. **Token.** Check `token.issuer` against the configured partner allowlist.
      Check `token.kid` is within the acceptance window (current or previous
      month) and that the issuer's JWKS publishes exactly four keys for it;
      fetch/cache that JWKS. Verify `sig` over `msg` under key `kid.meta` (RSABSSA
      verify). Burn `SHA-256(msg)` in the spent-set —
      atomic set-if-absent with 70-day TTL. Already present → reject
      (`token_reused`), drop the envelope. Then, if `token.meta` is not a value the
      operator accepts for that issuer, discard the envelope silently: no storage,
      quorum or delivery (§4.1).
   4. **Sighting gate** (`sighting` only; a `search` skips this step). Every ad's
      `brand` must be on the watchlist version claimed or the previous one, and
      that version must not be expired. Each ad's `observed_domain` must equal its
      `brand` or be a subdomain of it. Membership in `authorized_domains` does not
      suppress that match. Any failing ad rejects the whole envelope. Then, for
      each ad, increment the quorum counter for `(brand, grouping hash, country,
      UTC day)`, where the grouping hash is defined below and `country` is the
      wrapper's. One token counts once per counter. The first sighting of a new
      `(brand, grouping hash)` enters the analyst **triage** queue. At count ≥ K,
      the group escalates automatically as a **candidate**.
   5. **Store.** Store the accepted envelope with its receipt time and the wrapper,
      for 90 days.
   6. **Deliver** through a durable outbox with retries:
      - `sighting`: to the operator's analysis systems, with the wrapper's country
        and the effective device.
      - `search`: to the issuing partner's job sink (§6.2). A `search` whose issuer
        has no configured job sink is rejected.

The **effective device** is the envelope's `device` when present, otherwise the
wrapper's. The collector never records connection IPs or request headers.

### Grouping and persistence

The grouping hash is SHA-256 of the JSON array
`['lookup-v3', observed_domain, identity, creative]`, computed per ad:

- `identity` is `['id', advertiser.id]` when an AR identifier is present; otherwise
  `['name', lowercase(NFC(name)), lowercase(NFC(country ?? ''))]`.
- `creative` is `lowercase(NFC(title))`, or `null`.

The page-scoped batch code and atParameter, `ad_id` and `ad_html` are excluded from
this grouping key, so new page/request values do not split the same
advertiser/creative into new review groups. The complete accepted envelope,
including all of these values, is still persisted for **90 days**. Grouping does
not remove payload correlation.

### 6.1 Human review and evidence

Human review starts at the first accepted report. K is a prioritization signal, not a gate. Creative and advertiser text is sanitized before construction, and the report also carries page-scoped request values, platform click data and sanitized ad markup. Those values may link reports to a Google page, request or click and must be treated as correlatable data in analyst access, exports and retention.

Operators should attempt independent reproduction for every candidate and record
the result. Reproduction and case publication are operational responsibilities.
Successful reproduction strengthens a filing; it is not required,
because cloaking, geo-targeting, and audience targeting defeat datacenter crawlers by
design, and those campaigns are exactly the ones only users ever witness. When
reproduction fails, the filing states plainly that its evidence is sanitized
partner-contributed sightings. Publication of a case remains gated on platform
enforcement action regardless of evidence source.

Collector rejection details must stay within the receiving service. The OHTTP gateway returns a generic encrypted response and does not expose these reasons. Clients never fall back to the collector directly.

### 6.2 Background search reports

Some hosts run background searches: a server operated by the host's partner (the
**job issuer**, the same partner whose issuer signs the host's tokens) chooses
keywords and asks participating clients to search them, to observe which ads the
platform serves for those keywords by country and device form. The `search` kind
lets such a host submit each results page through the same token and OHTTP path as sightings, instead of
returning results to the job issuer under the user's account credentials. The job
protocol itself — how a host receives, authenticates, schedules and runs jobs —
is host-specific and out of scope.

A host that runs background searches:

1. Runs them only for users who consented to background search (§1.1).
2. Submits one `search` envelope per results page, with one token from the same
   daily batch as sightings. Finishing a search never triggers issuance.
3. Sets `keyword` to the job keyword exactly as received from its job source,
   never re-derived from the page or its `q=` parameter, and `device` to the
   device form the search presented to the platform.
4. Sets `outcome` to `ok` for a completed search, including a page with zero ads,
   and to `blocked` (captcha, consent or "unusual traffic" page) or `error` for a
   failed attempt.
5. Reports every ad extracted from the page, with its position, without the
   watchlist match or authorization gate. It looks up each ad's advertiser and
   sends `null` when the lookup fails.
6. Applies every sanitization rule in [`envelope.md`](envelope.md) except query
   redaction.
7. Submits after a uniformly random delay of 60–900 s from search completion
   (`SEARCH_SUBMIT_DELAY`), persisting pending submissions across background-worker
   restarts so that a restart neither loses a submission nor resets its delay.

The collector applies its steps 1–3, 5 and 6 (§6, step 4), skipping the sighting
gate and quorum. It delivers the result to the job sink configured for the token's issuer,
with bearer authentication; delivery is idempotent on a delivery ID. The delivered
result contains a delivery ID, the receipt time, `observed_hour`, the wrapper's
country (`null` when `ZZ`), the effective device, `keyword`, `outcome` and the ads
(position, observed domain, `ad_id`, advertiser, creative, batch code and
`ad_html`). The token is never forwarded.

The envelope carries no account credential or account identifier. The job issuer
nevertheless knows which account polled which job when it assigned it, and can
correlate a result with that assignment by keyword, device, country and timing
(§7). A job issuer should keep no durable record linking accounts to assigned
jobs and should discard assignment state when a job expires. That is an
operational choice of the job issuer, not a property this protocol enforces.

## 7. What this protects against — and what it doesn't

**Protections with the required deployment:**

- An independently operated OHTTP relay sees the client network address and
  encrypted bytes, while the gateway/collector receives report contents without
  that client IP. This depends on independent operation and header handling. The
  gateway/collector still receives the relay-derived country and device form.
- Blind signatures prevent the token's random nonce/signature from directly
  identifying the account that obtained it. Fresh tokens do not introduce an
  account identifier into a report. The only issuer-chosen value a token carries is
  its public metadata: which of the epoch's four keys signed it (§4.1).
- Issuance quotas limit report volume when the partner supplies real user
  authentication and durable atomic quota storage. Local auth
  mocks and in-memory example quotas do not establish those production properties.
- A fresh published watchlist limits the scope of `sighting` reports. Unmatched
  candidates do not trigger lookups or sighting reports in the configured flow.
  Background `search` reports are not limited by the watchlist.
- Host-managed informed explicit consent gates participation; withdrawal stops
  future collection and reporting. This is an integration requirement, not a
  property established by OHTTP, a blind signature or the envelope schema.

**Limits:**

- **Payload correlation is deliberate.** Batch codes and atParameter are original
  Google page/request values. The at value includes a precise timestamp. A
  recipient can associate them with that page/request, and Google can correlate
  them against its records. Repeated values can connect reports. Do not describe
  reports as containing no identifiers, no precise timestamps, or no linkable data.
- **`ad_html` and click URLs carry platform click data.** They keep the platform's
  click links with `gclid` and `ai` values, and `gclid` values contain precise click
  timestamps. Hour bucketing of `observed_hour` therefore does not hide capture
  time from anyone holding `ad_html` or `click_url`, and the platform can recognize
  these values. `ad_id` is the same platform value as `ai`.
- **Relay-provided country and device form narrow the anonymity set.** A report
  from a less common country or device form is one of fewer possible clients.
  Combined with timing and the page-scoped values above, this metadata can help
  single out a client.
- **Targeting codes say a little about the user.** `advertiser.targeting` carries
  the platform's reason codes: which kinds of profile signal the platform says
  reached this user, for example that age or location interests were used, but not
  the values. The source sub-codes add a little to each category, for example
  whether a signal came from the user's account or was an estimate. The operator
  maps the codes to names with its own table, and anyone who knows the platform's
  codes can read them. Combined with the creative and the relay country, they say
  a little about the user who saw the ad. This applies to `search` reports too: a host-run search is
  made in the user's own browser session, so its lookups can return categories
  that reflect that user's profile even though the keyword was not theirs.
- **Issuer metadata partitions reports.** `token.meta` splits one issuer's reports
  into at most four groups per epoch, and together with country and device form
  it narrows anonymity sets further. The number of values is auditable from the
  JWKS; their meaning is private to the issuer, and the §4.1 constraints on what
  they encode are issuer obligations the protocol cannot check. Because
  unaccepted values are discarded silently, a participant cannot tell whether a
  given report was used.
- **With the passive-query option on, reports carry the user's own search query
  in clear.** Combined with country, device form, time and platform click data,
  that is personal browsing data. A single operator running the relay, gateway,
  collector and issuer could link a query to a client IP by timing; the protections
  against that are organisational, not cryptographic.
- **Query redaction is partial.** Sighting redaction leaves query terms in place
  where they coincide with the ad's observed domain or brand, so a recipient may
  see them. In URLs, a single term inside a longer word is not redacted, and
  protected platform tokens are left intact even if a query appears inside one
  ([`envelope.md`](envelope.md#protected-url-spans)). Background search keywords
  are not redacted at all.
- **The job issuer can correlate background search results with accounts.** It
  knows which account polled which job at assignment time. Keyword, device,
  country and arrival time can match a result to its assignment unless the job
  issuer discards assignment records and clients delay submission. The 60–900 s
  delay weakens timing correlation; it does not prevent it, particularly for a
  rarely assigned keyword.
- **Background searches run in the user's browser session.** The platform receives
  the searches and the advertiser lookups as that browser's traffic.
- OHTTP hides the client network IP from the gateway in the independent-relay
  design; it does not anonymize decrypted payload fields. It also does not hide
  the content script's advertiser lookup from Google.
- A platform can recognize its own creative.click_url parameters. Creative query
  and click-URL keyword redaction preserves unrelated evidence and does not remove
  the correlation properties of retained platform data. Redaction is not a claim
  that arbitrary opaque or encoded platform values contain no user information.
- Traffic analysis and relay/gateway collusion remain possible. A single operator
  controlling both components can associate client connections with report
  contents; this does not provide the independent-operator trust split. A single
  operator running the relay, gateway, collector and issuer (including a job
  issuer) gets no independent-operator separation at any point.
- A malicious shipped extension can exfiltrate data outside this protocol. The
  partner's client code remains a trust boundary.
- K distinct tokens approximates K distinct clients; it is enforced economically
  through quotas/account cost, not cryptographically. It prioritizes investigation
  and proves neither fraud nor independent users. Publication still requires
  corroborating platform enforcement.

## 8. Wire formats

Reports use envelope version `v: 3`, with two kinds, `sighting` and `search`; the
published watchlist uses format `v: 1`. These version fields identify separate
contracts. Envelope versions 1 and 2 are retired: no deployed client sent them,
and the v3 schema rejects them. v3 tokens are RFC 9474
`RSABSSA-SHA384-PSS-Deterministic` signatures under one of four epoch keys and carry
`token.kid` and `token.meta`. A non-null creative requires `title`, and inferred
destination fields are rejected. See [`envelope.md`](envelope.md) and
[`watchlist.md`](watchlist.md) for the field rules.

Changes to field meaning, privacy properties, required fields, cryptographic
algorithms or epoch rules require a coordinated contract revision. Do not silently
reinterpret stored reports or combine incompatible grouping counters: v3 grouping
hashes use the `lookup-v3` prefix and are not combined with earlier counters.

## References

- [RFC 9474 — RSA blind signatures](https://www.rfc-editor.org/rfc/rfc9474.html)
- [RFC 9458 — Oblivious HTTP](https://www.rfc-editor.org/rfc/rfc9458.html)
- [RFC 9292 — Binary HTTP](https://www.rfc-editor.org/rfc/rfc9292.html)
