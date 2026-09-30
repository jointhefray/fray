# Fray report envelopes — v1 and v2

[`envelope.schema.json`](envelope.schema.json) accepts two explicit versions:
`v: 1` creative sightings and `v: 2` Google advertiser lookup reports. Both
creative shapes require only `title`; neither includes an inferred destination
domain. Clients must sanitize fields before serializing an envelope; schema
validation checks structure, not whether the user's query has been removed.

The host MUST obtain each user's informed, explicit consent before enrolling them
in Fray. Participation is off by default, and withdrawal stops future collection
and reporting. Disclose the evidence, recipients and privacy limits before that
choice; see [`protocol.md` §1.1](protocol.md#11-informed-explicit-consent-before-enrollment).
Neither a client library, a valid token nor this schema independently establishes consent.

## V2 lookup report

V2 carries the advertiser details returned by Google's lookup, the original
`batchCode`, and the original `atParameter`. **These are page-scoped request values,
not anonymous ad fields.** The `atParameter` includes a precise 13-digit timestamp.
Recipients can associate these values with a Google page/request; Google can
correlate them with its own records. Repeated values can also connect reports.

OHTTP separates the client's network IP from report contents when its relay and
gateway are independently operated. It does not remove payload correlation. Blind
signatures protect the connection between token issuance and token spending; they
do not make the lookup fields unlinkable.

```json
{
  "v": 2,
  "watchlist_version": 12,
  "brand": "example-fashion.com",
  "platform": "google.com",
  "surface": "search",
  "observed_hour": "2026-08-29T14:00:00Z",
  "observed_domain": "shop.example-fashion.com",
  "creative": null,
  "advertiser": {
    "id": "AR1234567890",
    "name": "Example Merchant Ltd",
    "country": "United Kingdom"
  },
  "lookup": {
    "kind": "google-batchexecute",
    "batchCode": "illustrative-opaque-batch-value",
    "atParameter": "illustrative_token%3a1788000000123"
  },
  "token": {
    "issuer": "issuer.partner.example",
    "kid": "ep-2026-08",
    "msg": "qL7…base64…",
    "sig": "hJ2…base64…"
  }
}
```

The lookup strings above are fictional. Token fields are abbreviated for display.

| Field                         | V2 contract                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`                           | Exactly `2`.                                                                                                                                              |
| `watchlist_version` / `brand` | Fresh watchlist version and matched entry's domain.                                                                                                       |
| `platform` / `surface`        | Exactly `google.com` / `search`.                                                                                                                          |
| `observed_hour`               | A real UTC hour bucket, with minutes/seconds zero. This field is coarse; `lookup.atParameter` still contains a precise timestamp.                         |
| `observed_domain`             | The normalized displayed domain that matched the entry's domain exactly or as a subdomain. Maximum 253 characters; not a URL.                                       |
| `creative`                    | A sanitized creative with a required `title` and optional v1 fields, or `null` when extraction exposes lookup data without a usable creative. Null does not bypass the domain match. |
| `advertiser.id`               | Optional Google transparency ID: `AR` followed by 1–62 digits.                                                                                            |
| `advertiser.name`             | Required nonblank platform-returned name, at most 200 characters.                                                                                         |
| `advertiser.country`          | Optional nonblank advertiser country label/code, at most 100 characters. It is not client geography.                                                      |
| `lookup.kind`                 | Exactly `google-batchexecute`.                                                                                                                            |
| `lookup.batchCode`            | Original nonempty opaque batch string, no ASCII whitespace/control characters. Never truncated.                                                           |
| `lookup.atParameter`          | Original string: 10–512 URL-safe token characters, followed by `:`, `%3A` or `%3a`, followed by exactly 13 decimal digits. Never synthesized.             |
| `token`                       | One unused blind-signed sighting token, using the existing issuance protocol.                                                                             |

### V2 construction and handling

1. Extract the hostname from the ad's display URL, retaining subdomains and doing
   so before query-text redaction. Match it against a fresh watchlist before looking up
   the advertiser or constructing a report. Exact and subdomain matches count.
   A displayed primary brand domain still counts when it appears in
   `authorized_domains`: this flow looks up the advertiser behind the ad. Brand terms alone do not trigger this flow, and
   authorized-domain aliases are not automatically added as watched domains.
   Before reporting, the background must locally confirm a known unlisted advertiser ID against an explicit closed/none authorization list. Authorized or inconclusive identities stay local; see [`watchlist.md`](watchlist.md). Envelope schema validation does not fetch or enforce that authorization policy; the client must make the authorization decision before submission.
2. Redact the current query and the matching query terms from creative and
   advertiser name/country text before constructing the envelope. Redact matches within
   `creative.click_url` while preserving unrelated URL evidence, following the
   creative sanitization rules below. A query match alone does not discard the
   entire URL or creative. Construct the envelope from an explicit allowlist of fields; structural
   validation does not replace sanitization.
3. Copy `batchCode` and `atParameter` exactly as extracted. Preserve the colon or
   percent-encoded colon spelling; do not decode/re-encode, shorten, strip the
   timestamp, or replace these request values. This is a deliberate v2 exception
   to v1's restriction on page-scoped values and finer timestamps.
4. Whitelist transmitted objects. Do not include `adKey`, `atParameterEncoded`,
   raw lookup responses, cookies, account data, page URLs, explicit query fields,
   or other properties from the candidate. Unknown fields are schema errors.
5. Enforce a complete serialized UTF-8 envelope limit of **8064 bytes**
   (`8 * 1024 - 128`) to leave room for the collector wrapper. Reject an oversized
   report; never truncate lookup values to make it fit.

The collector accepts both versions and persists the complete accepted envelope
for the raw-report retention period. V2 batch/at values therefore remain present
in stored reports. They are excluded from grouping keys, which use the observed
domain, advertiser identity and optional creative. Excluding them from grouping
is not a claim that they cannot be used for correlation.

The remaining sections describe the **v1** format. Its
stronger field restrictions must not be presented as properties of v2.

## V1 example

```json
{
  "v": 1,
  "watchlist_version": 12,
  "brand": "example-fashion.com",
  "platform": "google.com",
  "surface": "search",
  "observed_hour": "2026-08-29T14:00:00Z",
  "creative": {
    "title": "Example Fashion Clearance — 90% Off Everything",
    "body": "Final closing down sale. All stock must go today.",
    "display_url": "example-fashion.com/sale",
    "click_url": "https://www.googleadservices.com/pagead/aclk?sa=L&ai=C0AAAAAAAAAAopaqueAAAAAAAAAAAA&sig=AOD64_0AAAAAopaqueAAAAAAAAAAAA&adurl=https%3A%2F%2Fexamplefashion-outlet.shop%2Fsale",
    "advertiser_id": "AR55554444111122223333",
    "advertiser_name": "EF OUTLET LTD"
  },
  "token": {
    "issuer": "issuer.partner.example",
    "kid": "ep-2026-08",
    "msg": "qL7…base64…",
    "sig": "hJ2…base64…"
  }
}
```

The OHTTP gateway decrypts the report and wraps it before forwarding to the private collector:

```json
{ "country": "ZZ", "envelope": { …as above… } }
```

`ZZ` means unknown country. The OHTTP profile does not derive country from the client IP. Clients MUST NOT put client geography inside the envelope; unknown fields are rejected. The v2 advertiser.country field describes the advertiser, not the client.

## V1 fields

| Field                              | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`                                | Envelope version. This document describes `1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `watchlist_version`                | Integer version of the published watchlist the client matched against. Lets the collector discount hits from stale lists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `brand`                            | The watchlist entry's `domain` that matched. Never free text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `platform`                         | Platform token as in the advertisers.txt registry (`google.com`, `microsoft.com`, …) for the ad system that served the creative.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `surface`                          | `search` for search results; `feed` for YouTube feed ads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `observed_hour`                    | Observation time truncated to the hour, UTC, RFC 3339. Never finer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `creative.title` / `creative.body` | Visible ad text **after sanitization** (below). Title is required; body is optional. Truncated to 300 / 1000 chars.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `creative.display_url`             | The display URL string as shown, sans any query string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `creative.click_url`               | The ad's served click href after query-keyword redaction, preserving unrelated URL evidence. On Google this is normally the `googleadservices.com/pagead/aclk?…` redirector. Optional, HTTPS only, no embedded credentials, ≤ 2048 characters after sanitization, and never followed. This field preserves platform parameters except the matched query spans; it is sanitized evidence and must not be represented as an exact original href when redacted. See rule 2 below. |
| `creative.advertiser_id`           | Platform transparency identifier if the surface exposes one (e.g. Google's `AR…`). Optional.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `creative.advertiser_name`         | Advertiser name as shown by the platform's disclosure UI. Optional.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `token`                            | One unused sighting token: issuing host, epoch key id, base64 message and signature. See [`protocol.md`](protocol.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Creative sanitization (both versions, client-side before construction)

1. **Redact search-query matches, retaining the remaining evidence.** Do not copy
   the user's query into an explicit report field. Platforms may insert it into
   creatives through dynamic keyword insertion. The client MUST replace each
   occurrence of the complete trimmed query, and each whitespace-separated query
   term of length ≥ 3, with `‹q›` in creative title/body, display text and advertiser
   name text; v2 also applies this to advertiser name/country. Matching is
   case-insensitive. Try longer patterns first, collapse adjacent placeholders,
   and redact before truncating to field limits. Short terms are not independently
   redacted, but the complete query is matched regardless of its length.

   Text matching uses a substring rule. Click URLs use the
   letter/digit boundary rule in rule 2 so a coincidental substring inside an
   opaque identifier does not erase unrelated evidence. A match redacts the
   matching span; it does not discard the remaining creative or click URL.
2. **URL parameters stripped in every URL field except the ad's own click URL.** Of the
   URL-bearing fields the client composes, `display_url` keeps only the string up to the
   first `?` or `#`. The client does not infer a destination domain or decode
   redirect parameters to determine one. The ad's href is never followed: no fetch,
   no prefetch, no click, no HEAD. (`title` and `body` are visible ad copy, not URL fields;
   they are carried after rule 1's redaction and truncation and are not otherwise rewritten,
   so a URL the advertiser printed into its own ad text stays as the platform rendered it.)

   The single parameter-stripping exception is `creative.click_url`: unrelated
   platform parameters and original URL bytes are retained because they may help
   identify the served ad during investigation. The client MUST redact matching
   query spans in this field instead of dropping the entire URL. It neither
   invents nor completes platform parameters and never adds values from cookies,
   storage, accounts, install IDs or the surrounding page.

   Match the complete trimmed query and its whitespace-separated terms of length
   ≥ 3, case-insensitively, with boundaries defined by the start/end of the string
   or a character that is not a Unicode letter or digit. Whitespace between query
   words may match a whitespace run in a decoded form. Inspect the raw URL and
   up to eight successive decoding rounds, including percent-encoded text,
   nested encoded URL values and `+` as a space separator. Invalid UTF-8 bytes
   are inspected as replacement characters so they cannot hide readable query
   text beside them.

   Replace only the corresponding original spans, preserving the other bytes
   and parameters. Spans in a URL authority/hostname use the ASCII label-safe
   marker `redacted`; this also applies to a nested URL's authority identified
   during decoding. Other spans use URL-encoded `‹q›`
   (`%E2%80%B9q%E2%80%BA`). The host-safe marker avoids introducing invalid Unicode
   percent escapes into a hostname. Neither marker identifies a user. Repeated
   sanitization at the content/background boundaries must be idempotent.

   A keyword match is not a reason to omit the URL. Omission is still required
   when the input is invalid or unsafe, cannot be safely inspected within the
   eight-round decoding bound, or the input or sanitized result fails the HTTPS,
   credential, whitespace/control-character or 2048-character limits. Backslashes
   are not accepted. If a ninth decoding round would change the inspected form,
   omit the field. Do not truncate a URL to make it fit. If no spans require
   redaction, retain the valid URL unchanged.

   **What the click URL carries.** The parameters inside an aclk URL belong to the platform
   that served the ad. That platform issued them, so that platform can correlate them
   against its own logs. Remaining parameters can still carry correlatable
   platform data after keyword redaction; do not describe the result as free of
   identifiers or guaranteed unlinkable. No additional cookie, account or client
   identifier may be appended. The reported URL is sanitized evidence; investigators
   must not claim a redacted value is byte-for-byte what the platform originally
   served. Every other URL field still loses its query string and fragment.

The following additional restrictions describe v1. V2's original batch/at
values remain the explicit exception described above; do not apply text or URL
redaction to those opaque lookup fields and claim they became anonymous.

3. **No added user identifiers.** Nothing from cookies, storage, accounts, extension install IDs, or
   the page outside the ad element itself may appear in the envelope.
4. **Hour bucketing** is applied to the observation timestamp at capture, not at
   send. Do not create or send a finer client observation timestamp. Retained
   platform click-URL parameters may still carry their own timing information.
5. **Watchlist hits only.** If nothing on the published watchlist matched, no envelope is
   ever created. Non-matching ads leave no trace.

## V1 size

Serialized envelopes MUST be ≤ 8 KiB. The example collector limits the complete
gateway-wrapped request body to 8 KiB, so clients must also leave room for that
wrapper. Oversized request bodies are rejected before entering the verification pipeline.
