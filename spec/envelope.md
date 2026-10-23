# Fray report envelope

Reports use wire version `v: 3`, defined in
[`envelope.schema.json`](envelope.schema.json). One envelope describes one Google
results page and carries one token. Versions 1 and 2 are retired: no deployed
client sent them, and the schema no longer accepts them.

Each kind has two modes, distinguished by the presence of `lookup`:

- **Default (client-resolved).** The client looks up each advertiser itself, in the
  user's browser, and sends the advertiser details. The envelope carries **no**
  `lookup.atParameter` and **no** `batch_code`. The page's `at` value is a CSRF
  token bound to the user's Google session and carries a precise timestamp; batch
  codes are page-scoped request values. In default mode neither leaves the client:
  the client uses them, with the Google account index from the same page, only
  locally for its own lookup.
- **Delegated (optional, a partner choice).** The client skips its own lookup and
  sends the page's `lookup.atParameter` and each ad's `batch_code` instead of
  advertiser details. The operator resolves the advertiser server-side
  ([`protocol.md` §6.3](protocol.md#63-delegated-advertiser-resolution)).

The client never sends the Google account index in either mode. `kind` is
`sighting` or `search` in both modes.

Clients must sanitize fields before serializing an envelope. Schema validation
checks structure, not whether the user's query has been removed or whether
`ad_html` was produced by the procedure below.

The host MUST obtain each user's informed, explicit consent before enrolling them
in Fray. Participation is off by default, and withdrawal stops future collection
and reporting. Disclose the evidence, recipients and privacy limits before that
choice, including background searches if the host runs them; see
[`protocol.md` §1.1](protocol.md#11-informed-explicit-consent-before-enrollment).
Neither a client library, a valid token nor this schema independently establishes consent.

## Report kinds

| | `sighting` | `search` |
| --- | --- | --- |
| Trigger | A results page the user visited | A background search the host ran for a server-chosen keyword ([`protocol.md` §6.2](protocol.md#62-background-search-reports)) |
| Ads reported | 1–20. Default: likely unauthorized ads only. Delegated: every watchlist-matched ad with a batch code, before its authorization is known | Every ad extracted from the page, 0–20 (in delegated mode, every ad with a batch code) |
| Watchlist domain match | Required for every ad | Not applied |
| Authorization gate | Default: client, before submission. Delegated: operator, after server-side resolution | Not applied |
| Query redaction | Required (creative, advertiser text, click URL, `ad_html`) | Not applied. Every other sanitization rule applies |
| `keyword` | Optional, partner opt-in only; absent by default | Required |
| `outcome` | Not allowed | Required |
| `device` | Optional; the collector uses the relay's value when absent | Required |
| `lookup` | Default: not allowed. Delegated: required | Default: not allowed. Delegated: required |
| Per-ad `batch_code` | Default: not allowed. Delegated: required | Default: not allowed. Delegated: required |
| Per-ad `advertiser` | Default: object. Delegated: not allowed | Default: object, or `null` when the lookup failed. Delegated: not allowed |
| Submission | When ready | After a uniformly random delay of 60–900 s from search completion |

Both kinds carry sanitized creatives, sanitized ad HTML and platform-issued
values in both modes. **Default reports are not unlinkable:** the click links kept
in `creative.click_url` and `ad_html` carry `gclid` and `ai` values that the
platform issued, including precise click timestamps inside `gclid`. Recipients can
associate these values with a Google click, and Google can correlate them with its
own records. **Delegated reports also carry page-scoped request values:**
`lookup.atParameter` is bound to the user's Google session and includes a precise
13-digit timestamp, and batch codes belong to the page's requests. Recipients can
associate them with a Google page or request. Repeated values can connect reports
in either mode.

OHTTP separates the client's network IP from report contents when its relay and
gateway are independently operated. It does not remove payload correlation, and
the relay adds the client's coarse country and device form
([`relay.md`](relay.md)). Blind signatures protect the connection between token
issuance and token spending, except for the issuer-assigned metadata value, which
each token carries openly and which selects the key that signed it
([`protocol.md` §4.1](protocol.md#41-issuer-metadata)); they do not make the report
fields unlinkable.

## Page-level fields

| Field | `sighting` | `search` | Contract |
| --- | --- | --- | --- |
| `v` | Required | Required | Exactly `3`. |
| `kind` | `"sighting"` | `"search"` | Selects the report kind. |
| `watchlist_version` | Required | Not allowed | Integer ≥ 1: the fresh watchlist version the ads were matched against. |
| `platform` / `surface` | Required | Required | Exactly `google.com` / `search`. |
| `observed_hour` | Required | Required | `YYYY-MM-DDTHH:00:00Z`, a real UTC hour bucket taken at capture. This field is coarse; `click_url` and `ad_html`, and in delegated mode `lookup.atParameter`, still carry precise timestamps. |
| `device` | Optional | Required | A [device value](#device-form). On a `sighting`, it overrides the relay's value; when absent, the relay's value is used. On a `search`, it is the device form the search presented to the platform, which can differ from the browser's own. |
| `keyword` | Optional (partner opt-in) | Required | 1–200 characters, no C0 control characters or DEL, at least one non-whitespace character. Not redacted. On a `sighting`: absent by default; present only when the partner has opted in to sending the passive search query, as the page's search query, NFC-normalized and trimmed ([Sighting construction](#sighting)). On a `search`: the job keyword exactly as the host received it from its job source; never re-derived from the page or its `q=` parameter. |
| `outcome` | Not allowed | Required | `ok`, `blocked` or `error`; see [Search construction](#search). |
| `lookup` | Delegated only (required) | Delegated only (required) | Page-level lookup values for server-side resolution; see [Nested objects](#nested-objects). Not allowed in default mode. |
| `ads` | 1–20 sighting ads | 0–20 search ads | See [Per-ad fields](#per-ad-fields). |
| `token` | Required | Required | One unused blind-signed token from the issuance protocol; see [Nested objects](#nested-objects). |

"Not allowed" means the schema rejects the field. Unknown fields are schema
errors at every level.

## Per-ad fields

| Field | Sighting ad | Search ad | Contract |
| --- | --- | --- | --- |
| `brand` | Required | Not allowed | The matched watchlist entry's primary `domain`. |
| `position` | Not allowed | Required | Integer 1–50: the ad's 1-based position among the ads on the results page, in page order. |
| `observed_domain` | Required | Required | The normalized hostname from the ad's display URL: lowercase letter/digit/hyphen labels with an alphabetic top-level label, at most 253 characters; not a URL. On a sighting it equals `brand` or is a subdomain of it. |
| `ad_id` | Optional | Optional | The platform's identifier for the served creative, as returned by the advertiser lookup. It equals the `ai=` parameter of the ad's main click link. 1–512 characters, none in U+0000–U+0020 or U+007F. Allowed in both modes. |
| `creative` | Required | Required | A sanitized [creative](#creative-fields) with a required `title`, or `null` when extraction exposes the ad without a usable creative. Null does not bypass the sighting domain match. |
| `advertiser` | Default: required, object. Delegated: not allowed | Default: required, object or `null`. Delegated: not allowed | The advertiser returned by the client's lookup. `null` only on a default search ad whose lookup failed. |
| `batch_code` | Delegated only (required) | Delegated only (required) | The ad's original nonempty opaque batch string, at most 8064 characters, none in U+0000–U+0020 or U+007F, for server-side resolution. Never truncated. Not allowed in default mode. |
| `ad_html` | Required, string or `null` | Required, string or `null` | Markup of the ad's container produced by the [`ad_html` sanitization](#ad_html-sanitization), at most 65536 UTF-8 bytes, or `null`. |

`ad_id` is platform data the platform can correlate with its own records, like the
click link it is taken from. It adds no value beyond the `ai=` parameter that
`ad_html` or `creative.click_url` already carries when either is sent.

## Nested objects

| Field | Contract |
| --- | --- |
| `advertiser.id` | Optional Google transparency ID: `AR` followed by 1–62 digits. |
| `advertiser.name` | Required nonblank platform-returned name, at most 200 characters, no C0 control characters or DEL. |
| `advertiser.country` | Optional nonblank advertiser country label or code, at most 100 characters, same character rule. It describes the advertiser, not the client. |
| `advertiser.targeting` | Optional. The platform's raw "why this ad" targeting reason codes from the advertiser lookup, restricted to tuples of small non-negative integers or `null`: at most 32 unique tuples, each of 1–8 elements. The first element is the reason category, an integer 0–65535; the rest are the platform's source sub-codes, each an integer 0–65535 or `null`. A bare category number in the platform data is carried as a one-element tuple. The client drops any entry containing anything else, so no value or free text can be carried. `[]` means the lookup resolved but returned no usable targeting information: no targeting block, or one whose reasons were absent or all invalid. The field is absent when the lookup failed, or when it resolved with an explicitly empty reasons list. The collector maps categories to names with the operator's own table, which this protocol does not publish. Not query-redacted: the field holds only integers. |
| `lookup.kind` | Delegated mode only. Exactly `google-batchexecute`. |
| `lookup.atParameter` | Delegated mode only. The page's original lookup token, bound to the user's Google session: 10–512 URL-safe token characters, followed by `:`, `%3A` or `%3a`, followed by exactly 13 decimal digits. At most 528 characters. Never synthesized. |
| `token.issuer` | The issuer's name, in the same domain form as `observed_domain`. |
| `token.kid` | `ep-YYYY-MM`, the epoch ID. The signing key is the issuer's JWK `<kid>.<meta>`. |
| `token.meta` | Integer 0, 1, 2 or 3, the only metadata values that exist: two bits in total, deliberately too few to identify anyone. This is the issuer-assigned public metadata the token was issued with; it selects which of the epoch's four keys signed the token (JWK `kid` `<kid>.<meta>`). The issuer defines its meaning privately ([`protocol.md` §4.1](protocol.md#41-issuer-metadata)). |
| `token.msg` | The 32-byte token message, base64 or base64url, 43–45 characters. |
| `token.sig` | The finalized RFC 9474 blind signature (`RSABSSA-SHA384-PSS-Deterministic`) over `msg` under key `<kid>.<meta>`, base64 or base64url, 300–1400 characters. |

`advertiser` and its fields appear only in default envelopes; `lookup` appears only
in delegated envelopes.

## Creative fields

`creative` may be `null`. When present, it has the following fields and accepts
no additional properties. Destination domains are not inferred or sent.

| Field | Meaning |
| --- | --- |
| `title` | Required visible ad title after sanitization, 1–300 characters. |
| `body` | Optional visible ad body after sanitization, at most 1000 characters. |
| `display_url` | Optional display text after sanitization, without query or fragment, at most 300 characters. |
| `click_url` | Optional served HTTPS href after sanitization, 12–2048 characters, without embedded credentials or whitespace. Never followed. Preserve unrelated URL evidence as specified below. |
| `advertiser_id` | Optional platform transparency ID: `AR` followed by 1–62 digits. |
| `advertiser_name` | Optional sanitized name shown by the platform's disclosure UI, at most 200 characters. |

## Construction and handling

Every envelope is built from an explicit allowlist of fields. Do not include
`adKey`, `atParameterEncoded`, raw lookup responses, cookies, account data, page
URLs, explicit query fields (other than `keyword` where this contract allows it) or other
properties from the candidate. Unknown fields are schema errors. Never send the
Google account index from the page, in either mode.

In default mode, the client uses the page's `at` value, the batch codes and the
account index only for its own advertiser lookup and does not put them in the
envelope. In delegated mode, copy `lookup.atParameter` and each `batch_code`
exactly as extracted: preserve the colon or percent-encoded colon spelling; do not
decode, re-encode, shorten, strip the timestamp from or replace these values. They
deliberately retain their page/request association. Copy `ad_id` as the lookup
returned it. Copy `token.kid` and `token.meta` as stored with the token at
issuance.

### Sighting

1. For each ad on the results page, extract the hostname from the ad's display
   URL, retaining subdomains and doing so before query redaction. Match it against
   a fresh watchlist before looking up the advertiser. Exact and subdomain matches
   count. A displayed primary brand domain still counts when it appears in
   `authorized_domains`: this flow looks up the advertiser behind the ad. Brand
   terms alone do not trigger this flow, and authorized-domain aliases are not
   automatically added as watched domains.
2. **Default mode.** Look up each matched ad's advertiser and evaluate its ID
   locally against the most specific matching entry's explicit closed/none
   authorization list ([`watchlist.md`](watchlist.md)). Only `likely-unauthorized`
   ads are reported, with their advertiser details. Authorized and inconclusive
   identities stay local. Recheck the current policy after lookup and after token
   reservation, and drop any ad that is no longer likely unauthorized. If no ad
   remains, nothing is sent and no token is spent. Envelope schema validation does
   not fetch or enforce that authorization policy.

   **Delegated mode.** Skip the lookup and the authorization gate. Every
   watchlist-matched ad that has a batch code is reported, with its `batch_code` and
   no advertiser, before its authorization is known; the operator resolves the
   advertiser and applies the gate. If no ad matches, nothing is sent and no token
   is spent.
3. Put the qualifying ads extracted together from one results page into one
   envelope with one token. A delegated envelope also carries that page's
   `lookup.atParameter`; a default envelope carries neither it nor batch codes. An
   envelope holds at most 20 ads.
4. Sanitize every ad with the [creative sanitization rules](#creative-sanitization-client-side-before-construction),
   including query redaction, and the [`ad_html` sanitization](#ad_html-sanitization).
   A query match alone does not discard the entire URL or creative.
5. **Passive query (partner opt-in).** By default the envelope has no `keyword`:
   the query is redacted and not sent. A partner may opt in to sending the passive
   search query. With that option enabled, set `keyword` to the page's search query,
   NFC-normalized and trimmed, when the result is 1–200 characters and meets the
   field's character rule; otherwise omit it. When `keyword` is sent, skip query
   redaction for that sighting (creative, advertiser text, `click_url` and
   `ad_html`), as for a `search`: the query travels in clear anyway. Every other
   sanitization rule still applies. When it is not sent, redact as in step 4. The
   collector accepts a sighting `keyword` only from
   issuers configured to send it ([`protocol.md` §6](protocol.md#6-submission-and-verification)).
6. Enforce the [size limits](#size).

### Search

A `search` envelope reports one background search the host ran for a
server-chosen keyword ([`protocol.md` §6.2](protocol.md#62-background-search-reports)).

1. `keyword` is the job keyword exactly as the host received it from its job
   source. It is never re-derived from the page or its `q=` parameter.
2. `device` is the device form the search presented to the platform. A host can
   run a mobile search from a desktop browser, so the relay's value would be wrong.
3. `outcome` is `ok` for a completed search, including a results page with zero
   ads. `blocked` (a captcha, consent or "unusual traffic" page) and `error` (any
   other failure) are failed attempts.
4. `ads` lists every ad extracted from the page, in page order, each with its
   `position`. No watchlist match or authorization gate is applied: authorized
   advertisers and unwatched domains are reported too.
5. **Default mode:** look up each ad's advertiser, and use `advertiser: null` when
   the lookup fails; send no `lookup` or `batch_code`. **Delegated mode:** skip the
   lookup and send the page's `lookup.atParameter` and each ad's `batch_code`, with
   no advertiser; an ad without a batch code cannot be included.
6. Apply every sanitization rule below except query redaction. The keyword is
   chosen by the job source, not typed by the user, and is reported in full in
   `keyword`.
7. Enforce the [size limits](#size). Submit after a uniformly random delay of
   60–900 s from search completion. Hosts persist pending submissions across
   background-worker restarts; a restart neither loses a pending submission nor
   resets its delay.

The collector persists the complete accepted envelope for the raw-report retention
period. `ad_id`, `ad_html` and, in delegated envelopes, the lookup token and batch
codes therefore remain present in stored reports. They are excluded from grouping keys, which use the observed
domain, advertiser identity and optional creative title. Excluding them from
grouping is not a claim that they cannot be used for correlation.

## Creative sanitization (client-side before construction)

Rules 1, 2 and 3 apply to both kinds, except that a `search` envelope skips query
redaction: rule 1, the query-span redaction in rule 2 and the
[redaction exemptions](#redaction-exemptions) do not apply to it. Every other part
of these rules, including `authuser` removal and the click URL's omission
conditions, applies unchanged.

1. **Redact search-query matches, retaining the remaining evidence.** Do not copy
   the user's query into an explicit report field, except a sighting's `keyword`
   when the partner has opted in ([Sighting construction](#sighting), step 5); this
   rule applies unchanged in that case. Platforms may insert it into
   creatives through dynamic keyword insertion. The client MUST replace each
   occurrence of the complete trimmed query, and each whitespace-separated query
   term of length ≥ 3, with `‹q›` in creative title/body, display text and advertiser
   name text, including `advertiser.name` and `advertiser.country` (not
   `advertiser.targeting`, which holds only integer codes). Matching is
   case-insensitive. Try longer patterns first, collapse adjacent placeholders,
   and redact before truncating to field limits. Short terms are not independently
   redacted, but the complete query is matched regardless of its length. The
   [redaction exemptions](#redaction-exemptions) apply.

   Text matching uses a substring rule. URLs use the rules in rule 2: single terms
   match only at letter/digit boundaries, so a coincidental letter run inside an
   opaque value does not erase unrelated evidence, and protected URL spans are
   never redacted. A match redacts the matching span; it does not discard the
   remaining creative or click URL.
2. **URL parameters stripped in every URL field except the ad's own click URL.** Of the
   URL-bearing fields the client composes, `display_url` keeps only the string up to the
   first `?` or `#`. The client does not infer a destination domain or decode
   redirect parameters to determine one. The ad's href is never followed: no fetch,
   no prefetch, no click, no HEAD. (`title` and `body` are visible ad copy, not URL fields;
   they are carried after rule 1's redaction and truncation and are not otherwise rewritten,
   so a URL the advertiser printed into its own ad text stays as the platform rendered it.)
   `ad_html` is not a composed URL field; its URL attributes follow the
   [`ad_html` sanitization](#ad_html-sanitization), which uses the URL rules below.

   The single parameter-stripping exception is `creative.click_url`: unrelated
   platform parameters and original URL bytes are retained because they may help
   identify the served ad during investigation. The one parameter removed from it
   is `authuser`, which carries account data: remove every `authuser` query
   parameter, keeping all other bytes. An `authuser` parameter inside an encoded
   nested URL has its value blanked in place, so it reads `authuser=`, and the URL
   is kept. The client MUST redact matching query spans in this field instead of
   dropping the entire URL. It neither invents nor completes platform parameters
   and never adds values from cookies, storage, accounts, install IDs or the
   surrounding page.

   **URL matching.** Match the complete trimmed query and its whitespace-separated
   terms of length ≥ 3, case-insensitively, with boundaries defined by the start/end
   of the string or a character that is not a Unicode letter or digit. Whitespace
   between query words may match a whitespace run in a decoded form. In addition,
   when the complete trimmed query has at least three characters, match it as a
   plain substring, without the boundary rule, inside URL paths and parameter
   values; there, whitespace between query words matches any run of whitespace,
   `+`, `-`, `_` or `%20`. Single terms keep the boundary rule. Inspect the raw URL
   and up to eight successive decoding rounds, including percent-encoded text,
   nested encoded URL values and `+` as a space separator. Invalid UTF-8 bytes
   are inspected as replacement characters so they cannot hide readable query
   text beside them.

   Replace only the corresponding original spans, preserving the other bytes
   and parameters. Spans in a URL authority/hostname use the ASCII label-safe
   marker `redacted`; this also applies to a nested URL's authority identified
   during decoding. Other spans use URL-encoded `‹q›`
   (`%E2%80%B9q%E2%80%BA`). The host-safe marker avoids introducing invalid Unicode
   percent escapes into a hostname. Neither marker identifies a user. Repeated
   sanitization at the content/background boundaries must be idempotent. The
   [redaction exemptions](#redaction-exemptions) apply, and
   [protected spans](#protected-url-spans) are never redacted: a match that
   overlaps one is cut back to its parts outside the protected span.

   A keyword match is not a reason to omit the URL. Omission is still required
   when the input is invalid or unsafe, cannot be safely inspected within the
   eight-round decoding bound, or the input or sanitized result fails the HTTPS,
   credential, whitespace/control-character or 2048-character limits. Backslashes
   are not accepted. If a ninth decoding round would change the inspected form,
   omit the field. Do not truncate a URL to make it fit. If no spans require
   redaction or removal, retain the valid URL unchanged.

   **What the click URL carries.** The parameters inside an aclk URL belong to the platform
   that served the ad. That platform issued them, so that platform can correlate them
   against its own logs. Remaining parameters can still carry correlatable
   platform data after keyword redaction; do not describe the result as free of
   identifiers or guaranteed unlinkable. No additional cookie, account or client
   identifier may be appended. The reported URL is sanitized evidence; investigators
   must not claim a redacted value is byte-for-byte what the platform originally
   served. Every other composed URL field still loses its query string and fragment.

3. **No added user identifiers.** Do not append cookies, storage values, account
   data, extension install IDs or page URLs, and never send the page's Google
   account index. Remove `authuser` from `click_url` and from `ad_html` URLs.
   `ad_id` and the platform's own values inside `click_url` and `ad_html` are the
   permitted platform values in both modes; the original `lookup.atParameter` and
   each `batch_code` are permitted in delegated mode only. Do not apply text or URL redaction to
   the opaque fields and claim they became anonymous.
4. **Hour bucketing** applies to `observed_hour` at capture, not at send. Do not
   add another client observation timestamp. The `gclid` values in `click_url`
   and `ad_html` carry precise click timestamps, and in delegated mode the original
   `lookup.atParameter` retains its precise platform timestamp. Hour bucketing does not hide
   capture time from anyone holding those values.
5. **Watchlist and authorization checks** (`sighting` only). A fresh domain match
   is required for every reported ad in both modes. In default mode, a locally
   confirmed likely unauthorized advertiser is also required, and authorized and
   inconclusive candidates are not reported. In delegated mode the client applies
   only the domain match; the operator applies the authorization gate after
   resolving the advertiser. A `search` envelope applies neither check.

### Redaction exemptions

These exemptions apply to `sighting` envelopes only, to the text rule (rule 1),
the click-URL rule (rule 2) and `ad_html` alike, including the background check.
They are evaluated per ad.

1. **Domain and brand terms.** A query term of length ≥ 3 that occurs
   case-insensitively within that ad's `observed_domain` or matched `brand` is not
   redacted. The complete query is not redacted when it occurs case-insensitively
   within either value, or when every one of its whitespace-separated terms, of any
   length, does. For example, the query `nike outlet` on an ad whose
   `observed_domain` is `nike-outlet.shop` keeps "Nike Outlet" in the creative text.
   A query with any term outside the domain and brand still has the complete phrase
   redacted, and that term too when it has three or more characters.
2. **Protected URL spans**, listed [below](#protected-url-spans), are never
   redacted.

#### Protected URL spans

No redaction rule, including the complete-query substring rule, changes these
spans of a URL value, in `creative.click_url` or in `ad_html`:

1. **Platform hosts.** The authority of a platform host, at any nesting depth. The
   platform hosts are `google.com`, `googleadservices.com` and Google country hosts,
   each with or without `www.`: a host matching
   `^(www\.)?(googleadservices\.com|google\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2}))$`,
   such as `www.google.co.uk` or `www.google.com.hk`.
2. **Platform click parameters.** On a top-level platform click URL (a URL value, or
   an item of a comma-separated list, whose host is a platform host), the path,
   every parameter name and the values of these opaque platform parameters:
   `ae`, `ai`, `ase`, `aspm`, `category`, `cce`, `ch`, `cid`, `co`, `ctype`, `dct`,
   `ei`, `gclid`, `lsa`, `nis`, `num`, `pf`, `ri`, `sa`, `sig`, `sph`, `sqi`, `suid`,
   `ved`. A listed parameter whose value is itself a URL is not protected. `adurl`,
   `q` and every parameter not on the list are inspected and redacted normally.
3. **The observed domain.** A URL authority equal to the ad's `observed_domain` or
   a subdomain of it, at any nesting depth; this covers the `adurl` destination host
   and each `data-pcu` entry. In `ad_html`, a text node or non-URL attribute value
   (such as `data-dtld`) that is exactly that domain, ignoring case, surrounding
   whitespace and a trailing dot, is not redacted either.
4. **URL schemes.** A scheme such as `https://` is URL structure, never query text.

The platform click parameters are platform-generated tokens, numbers and flags. In
measurement on real click links, the user's query never appeared in them at a word
boundary; the only matches were coincidental letter runs inside the tokens, and
redacting those would corrupt the click evidence. The list is explicit, so a
parameter the platform adds later is inspected and redacted by default until it is
reviewed.

**Privacy consequences.** `observed_domain` and `brand` are sent unredacted, so
redacting a term found inside them hides nothing and would destroy the domain
evidence investigators validate. Consequently:

- **A recipient may see the user's query terms, or the complete query, where they
  coincide with the reported brand or domain.**
- In URLs, a single query term that occurs inside a longer word is not redacted,
  by design of the boundary rule. The complete query is redacted inside URL paths
  and parameter values only where it occurs outside the protected spans.
- Protected platform tokens are left intact, including where a query happens to
  appear inside one.
- When the partner has opted in to sending the passive search query and the sighting
  carries it in `keyword`, query redaction is skipped for that sighting: the query
  is sent in clear anyway, and redacting the ad copy would only corrupt it.

## `ad_html` sanitization

`ad_html` carries the ad's own rendered markup so investigators can examine the
creative and its click links as the platform served them. This procedure is
normative. A client that cannot complete it sends `null`.

The input is the ad's container element as rendered (the `div[data-text-ad]` root
or its mobile equivalent), never surrounding page markup. Work on a detached
clone, in a DOM context such as a content script or offscreen document:

1. **Remove elements.** Remove these elements with their contents: `script`,
   `style`, `noscript`, `template`, `iframe`, `frame`, `frameset`, `object`,
   `embed`, `applet`, `link`, `meta`, `base`, `form`, `input`, `textarea`,
   `select`, `foreignObject`. Remove comments and processing instructions.
2. **Remove attributes.** Remove every attribute whose name begins with `on`, and
   every `style`, `srcdoc`, `nonce`, `integrity`, `ping` and `data-aavs` attribute.
   `data-aavs` holds the ad's batch code, which is lookup material and never travels
   inside `ad_html` in either mode. Remove any attribute whose value, after removing
   ASCII whitespace and control characters, begins case-insensitively with
   `javascript:`, `vbscript:` or `data:`. The ad's `jsdata` attributes are kept,
   because ad parsers use them to identify the ad. Their last field is a page-scoped
   key into the results page's own data, not a batch code, and is not usable for a
   lookup without that page.
3. **Process URL attributes.** Treat an attribute value as a URL when, trimmed, it
   begins with `https://`, `http://`, `//` or `/`. This covers `href`, `src`,
   `srcset` and `data-*` URL attributes such as `data-rw` and `data-pcu`.
   1. Resolve root-relative (`/…`) and protocol-relative (`//…`) values against
      `https://www.google.com/` before other processing, item by item in a
      comma-separated list, so the markup is self-contained and its click links are
      absolute.
   2. Remove every `authuser` query parameter (account data), keeping all other
      bytes. An `authuser` value inside an encoded nested URL is blanked in place,
      and the URL is kept.
   3. For `sighting` only, redact query matches with the
      [URL matching rule](#creative-sanitization-client-side-before-construction)
      of creative sanitization rule 2, including the complete-query substring rule,
      subject to the [redaction exemptions](#redaction-exemptions) and
      [protected spans](#protected-url-spans).
   4. A value can fail only when inspection exceeds the eight-round decoding bound.
      A `data-*` URL attribute is never dropped: if one fails, the whole `ad_html`
      is `null`. Any other URL attribute that fails is removed. Rule 2's HTTPS-only
      and 2048-character limits apply to `click_url`, not to `ad_html` attributes.
4. **Redact text** (`sighting` only). Redact text nodes and non-URL attribute
   values with the text rule
   ([creative sanitization rule 1](#creative-sanitization-client-side-before-construction),
   `‹q›`), subject to the [redaction exemptions](#redaction-exemptions). A text
   node or non-URL attribute value that is exactly the ad's `observed_domain` is
   left unchanged.
5. **Serialize and check.** Serialize the clone's `outerHTML`. Send `null` if the
   result exceeds 65536 bytes, or still matches any of `/<script\b/i`,
   `/\son[a-z]+\s*=/i` or `/javascript\s*:/i`. The byte limit counts the UTF-8
   bytes of the raw string; measuring the JSON-escaped form is a conforming,
   stricter choice. These patterns also match some ordinary ad text, such as
   `online =` or `JavaScript:`; such an ad is sent with `ad_html: null`.

The background, which has no DOM, repeats step 5's checks on the string it
receives. For a `sighting`, it also sets `ad_html` to `null` if the complete
trimmed query appears case-insensitively in the string or its percent-decoded
form, applying exactly the same protections as the sanitizer: the check is skipped
when the complete query is exempt, and protected spans of URL attribute values are
ignored. The collector applies step 5's checks again and rejects the whole envelope
on failure; it never rewrites `ad_html`.

**What `ad_html` carries.** `ad_html` keeps the platform's click links with their
`gclid` and `ai` values. Like `click_url`, it carries platform data the platform
can correlate with its own records, including precise click timestamps inside
`gclid`. Hour bucketing does not hide capture time from anyone holding `ad_html`.
Sanitization removes active content and account parameters, and query text for
sightings outside the exemptions and protected spans above; it does not make the
markup free of identifiers or unlinkable.

## Size

Limits are checked on the serialized UTF-8 form:

| Limit | Bytes |
| --- | --- |
| Complete envelope | **524288** |
| Each `ad_html` string | **65536** |

The schema's `maxLength` on `ad_html` counts characters; the byte limit is
checked separately. A client whose envelope exceeds the envelope limit sets
`ad_html` to `null`, largest first, until it fits. If it still does not fit with
every `ad_html` null, the client does not send it. A client never truncates HTML,
lookup values or batch codes to make an envelope fit.

The gateway's wrapped body is limited to 532480 bytes, 8192 more than the
envelope limit. Transport limits are in [`relay.md`](relay.md#limits).

## Device form

| Value | Meaning |
| --- | --- |
| `android-mobile` | Android |
| `ios-mobile` | iPhone, iPad or iPod |
| `macos-desktop` | macOS |
| `windows-desktop` | Windows |
| `linux-desktop` | Linux other than Android or ChromeOS |
| `chromeos-desktop` | ChromeOS |
| `other` | Anything else, or unknown |

The relay derives a device form from the client's request headers
([`relay.md`](relay.md#device-form)). An envelope's `device`, when present,
overrides the relay's value: the **effective device** is the envelope's `device`
if present, otherwise the wrapper's. A `search` envelope always carries `device`,
so the relay's value is never used for it.

## Gateway wrapper

The OHTTP gateway decrypts the report and wraps it before forwarding it to the
private collector:

```json
{ "country": "GB", "device": "macos-desktop", "envelope": { …as below… } }
```

- `country` is the ISO 3166-1 alpha-2 code the relay derived from the client's
  IP geolocation, or `ZZ` when unknown.
- `device` is the relay's device form, or `other`.
- The gateway uses the relay's values only when the relay authenticated itself;
  otherwise it sends `ZZ` and `other`. See [`relay.md`](relay.md).

Clients MUST NOT put client geography inside the envelope; unknown fields are
rejected. The `advertiser.country` field describes the advertiser, not the client.

## Examples

All values below are fictional. Token fields are abbreviated for display and do
not meet the schema's length limits as shown.

### `sighting` (default mode)

```json
{
  "v": 3,
  "kind": "sighting",
  "watchlist_version": 12,
  "platform": "google.com",
  "surface": "search",
  "observed_hour": "2026-10-14T14:00:00Z",
  "ads": [
    {
      "brand": "example-fashion.com",
      "observed_domain": "shop.example-fashion.com",
      "ad_id": "ILLUSTRATIVE_AI_1",
      "creative": {
        "title": "‹q› Clearance – Up to 70% Off",
        "body": "Illustrative ad copy for documentation.",
        "display_url": "shop.example-fashion.com",
        "click_url": "https://www.google.com/aclk?sa=L&ai=ILLUSTRATIVE_AI_1&gclid=ILLUSTRATIVE_GCLID_1"
      },
      "advertiser": {
        "id": "AR1234567890",
        "name": "Example Merchant Ltd",
        "country": "United Kingdom",
        "targeting": [[3, 1], [12, null]]
      },
      "ad_html": "<div data-text-ad=\"1\"><a href=\"https://www.google.com/aclk?sa=L&amp;ai=ILLUSTRATIVE_AI_1&amp;gclid=ILLUSTRATIVE_GCLID_1\"><span>‹q› Clearance – Up to 70% Off</span></a><span>shop.example-fashion.com</span></div>"
    }
  ],
  "token": {
    "issuer": "issuer.partner.example",
    "kid": "ep-2026-10",
    "meta": 1,
    "msg": "qL7…base64…",
    "sig": "hJ2…base64…"
  }
}
```

This sighting has no `device`, so the collector uses the relay's value, and no
`keyword`, which is the default. As a default-mode envelope it carries the
advertiser details and no `lookup` or `batch_code`.

### `search` (default mode)

```json
{
  "v": 3,
  "kind": "search",
  "platform": "google.com",
  "surface": "search",
  "observed_hour": "2026-10-14T09:00:00Z",
  "device": "android-mobile",
  "keyword": "example bank login",
  "outcome": "ok",
  "ads": [
    {
      "position": 1,
      "observed_domain": "example-bank.co.uk",
      "ad_id": "ILLUSTRATIVE_AI_2",
      "creative": {
        "title": "Example Bank Login – Official Site",
        "display_url": "example-bank.co.uk",
        "click_url": "https://www.google.com/aclk?sa=L&ai=ILLUSTRATIVE_AI_2&gclid=ILLUSTRATIVE_GCLID_2"
      },
      "advertiser": {
        "id": "AR9876543210",
        "name": "Example Bank plc",
        "country": "United Kingdom"
      },
      "ad_html": "<div data-text-ad=\"1\"><a href=\"https://www.google.com/aclk?sa=L&amp;ai=ILLUSTRATIVE_AI_2&amp;gclid=ILLUSTRATIVE_GCLID_2\"><span>Example Bank Login – Official Site</span></a></div>"
    },
    {
      "position": 2,
      "observed_domain": "example-bank-support.example",
      "creative": {
        "title": "Example Bank Login Help"
      },
      "advertiser": null,
      "ad_html": null
    }
  ],
  "token": {
    "issuer": "issuer.partner.example",
    "kid": "ep-2026-10",
    "meta": 3,
    "msg": "Zt4…base64…",
    "sig": "pW9…base64…"
  }
}
```

The keyword appears unredacted in the creatives. The second ad's advertiser lookup
failed, and it has no usable `ad_html`.

### `sighting` (delegated mode)

```json
{
  "v": 3,
  "kind": "sighting",
  "watchlist_version": 12,
  "platform": "google.com",
  "surface": "search",
  "observed_hour": "2026-10-14T16:00:00Z",
  "lookup": {
    "kind": "google-batchexecute",
    "atParameter": "illustrative_token%3a1791994834567"
  },
  "ads": [
    {
      "brand": "example-fashion.com",
      "observed_domain": "example-fashion.com",
      "creative": {
        "title": "Example Fashion Sale – Free Delivery",
        "display_url": "example-fashion.com",
        "click_url": "https://www.google.com/aclk?sa=L&ai=ILLUSTRATIVE_AI_3&gclid=ILLUSTRATIVE_GCLID_3"
      },
      "batch_code": "illustrative-opaque-batch-value-3",
      "ad_html": "<div data-text-ad=\"1\"><a href=\"https://www.google.com/aclk?sa=L&amp;ai=ILLUSTRATIVE_AI_3&amp;gclid=ILLUSTRATIVE_GCLID_3\"><span>Example Fashion Sale – Free Delivery</span></a><span>example-fashion.com</span></div>"
    }
  ],
  "token": {
    "issuer": "issuer.partner.example",
    "kid": "ep-2026-10",
    "meta": 1,
    "msg": "Rk2…base64…",
    "sig": "Lm8…base64…"
  }
}
```

This envelope carries the page's lookup token and the ad's batch code instead of
advertiser details. The client matched the ad's domain against the watchlist but
did not look up the advertiser or apply the authorization gate; the operator does
both after resolving it.
