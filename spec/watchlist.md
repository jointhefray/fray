# Watchlist format

The watchlist is the published, versioned list of watched brands.
The JSON format is `v: 1`; the matching and authorization rules are defined
below. Unmatched candidates are not looked up or submitted by the passive
(`sighting`) reporting flow. Publishing the list makes that reporting scope visible
to users and partners. Background `search` reports are not gated by the watchlist
([`protocol.md` §6.2](protocol.md#62-background-search-reports)).

The public Fray watchlist is available at
[`registry.jointhefray.org/v1/watchlist.json`](https://registry.jointhefray.org/v1/watchlist.json).
Its format is defined by [`watchlist.schema.json`](watchlist.schema.json).

## Example

```json
{
  "v": 1,
  "version": 12,
  "published": "2026-08-25T09:00:00Z",
  "expires": "2026-09-25T09:00:00Z",
  "entries": [
    {
      "domain": "example-fashion.com",
      "brand_terms": ["example fashion"],
      "authorized_domains": ["example-fashion.com", "examplefashion.co.uk"],
      "policy": "closed",
      "authorized_advertiser_ids": ["AR12345678901234567890"]
    },
    {
      "domain": "example-bank.co.uk",
      "brand_terms": ["example bank"],
      "authorized_domains": ["example-bank.co.uk"],
      "policy": "none",
      "authorized_advertiser_ids": []
    }
  ]
}
```

## Fields

| Field                          | Meaning                                                                                                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`                            | Format version (this document: `1`).                                                                                                                                                                           |
| `version`                      | Monotonic integer. Envelopes cite it as `watchlist_version`.                                                                                                                                                   |
| `published` / `expires`        | RFC 3339. Clients MUST stop matching against an expired list and fetch a fresh one; an unreachable update endpoint means matching stops, not that a stale list runs forever.                                   |
| `entries[].domain`             | Normalized primary domain identifying the brand (a more-specific subdomain entry overrides a parent) — the value the envelope carries back as `brand`.                                                                                                                     |
| `entries[].brand_terms`        | Lowercase brand mentions for informational use. They do not trigger the domain-only reporting flow.                                                                                                 |
| `entries[].authorized_domains` | Domains that legitimately belong to the brand. Informational only: the matcher does not suppress hits or add aliases to its match set using this list. |
| `entries[].policy`             | Authorization completeness: `open` or absent cannot support an unlisted-identity report; `closed` declares a complete authorized ID list; `none` requires an explicit empty list for reporting.                                                              |
| `entries[].authorized_advertiser_ids` | Explicit Google advertiser ID allowlist (`AR` followed by 1–62 digits, matching the report contract). Missing means unknown authorizations, not an empty allowlist. |

Entry domains MUST be unique. `none` cannot contain authorized IDs. Clients must preserve policy and ID arrays in their validated cache. Lists without an explicit authorization array may support lookups but cannot authorize reports.

## Lookup rule

These rules apply only after the host has obtained informed explicit consent to
Fray participation ([`protocol.md` §1.1](protocol.md#11-informed-explicit-consent-before-enrollment)).
A domain match or authorization violation does not enroll a user or establish consent.

Match only a normalized observed domain that equals an entry's `domain`, or ends
with `.` followed by that domain. A domain boundary is required: matching
`example.com` must not match `notexample.com` or `example.com.attacker.test`.
The reporting integration extracts a hostname from the ad's display URL before
query redaction, keeping subdomains. For example, `https://shop.example.com/sale`
produces `shop.example.com`. It sends that hostname as `observed_domain` when it
matches, with the entry's primary `domain` as `brand`. Parsing does not reduce it
through a public-suffix list or infer a destination from the click URL or its
redirect parameters.

Do not suppress a match because the displayed domain also appears in
`authorized_domains`. Fraudulent advertising can send the shopper to the real
business while claiming an unearned commission. This rule does not declare the ad
fraudulent; it makes the account eligible for lookup and investigation.

`brand_terms` alone never trigger a lookup or report. Other aliases in `authorized_domains` do not
become watched domains automatically; publish a corresponding primary entry if
an alias should be watched. `creative: null` is allowed only after the same domain
match, when a candidate exposes usable lookup data but no usable creative.

## Local authorization gate

After Google returns an advertiser, evaluate its ID against the most specific matching entry. An authorized ID produces a local `authorized` result. A missing/malformed advertiser ID, missing authorization array, or absent/`open` policy produces `unknown`. Neither result is included in a `sighting` envelope, and a page with no likely unauthorized ad consumes no report token.

Only a known ID absent from an explicit `closed` authorization list, or a known ID under `none` with an explicit empty list, produces `likely-unauthorized` and permits submission. The comparison happens locally and fails closed on incomplete data. It establishes an apparent authorization violation; investigation is still needed before calling an ad fraudulent.

This gate runs on the client in the default (client-resolved) mode. In the optional delegated mode ([`protocol.md` §6.3](protocol.md#63-delegated-advertiser-resolution)) the client applies only the domain match above; the operator resolves the advertiser server-side and applies these same rules.

Re-read the current cached policy after lookup and after any asynchronous token reservation. If the domain is removed, authorizations change, or the list expires, apply the new decision before sending. The host may display advertiser ID/name/country and the decision in its local UI. No lookup response or evaluation is persisted in the watchlist cache.

## Background cache and update cadence

The extension background owns the validated watchlist cache and persists it using
the partner's storage adapter. Cache freshness lasts at most **24 hours** after a
successful fetch and never beyond the document's `expires` timestamp. A reload
must retain the original fetch time; reading from storage does not renew the TTL.

Match locally while that cache is fresh. Refresh on a daily schedule, and refresh
when the cache is absent or stale. Failed refreshes may leave an already-fresh
copy usable only until its existing deadline. Once either the 24-hour TTL or
`expires` is reached, matching stops until a valid replacement arrives. Never
extend freshness because the update endpoint is unavailable.

Fetches carry no credentials or explicit user identifiers. Watchlist responses
are validated before persistence. This cache stores public matching scope; it
must not store Google page tokens, lookup responses, or client browsing activity.

## Delegated domain checks

A partner that operates its own authorization source may keep the whole list,
domains included, on its server. The extension then does not download the
watchlist.

For each results-page scan, after consent, the **background script** sends the
hostnames displayed by that page's ads to the partner's check endpoint:

```http
POST https://issuer.partner.example/fray/check
Authorization: Bearer <the partner's account credential>
Content-Type: application/json

{ "domains": ["shop.example-fashion.com", "unrelated.example"] }
```

`domains` holds 1–100 unique, lowercase ASCII hostnames taken from the ads'
display URLs, subdomains retained. The request carries nothing else: no query,
page URL, creative, Google page token, batch code or observed advertiser. Use
`credentials: omit` and omit the referrer.

A successful response is a watchlist document
([`watchlist.schema.json`](watchlist.schema.json)) holding **only** the entries
that cover a submitted hostname, the most specific watched suffix of each:

```json
{
  "v": 1,
  "version": 12,
  "published": "2026-11-06T09:00:00Z",
  "expires": "2026-11-07T09:00:00Z",
  "entries": [
    {
      "domain": "example-fashion.com",
      "brand_terms": [],
      "authorized_domains": ["example-fashion.com"],
      "policy": "closed",
      "authorized_advertiser_ids": ["AR12345678901234567890"]
    }
  ]
}
```

A hostname the operator does not watch has no entry; that is not `policy: none`.
`version` and `expires` are those of the operator's current snapshot, and every
returned record is complete: never truncate an authorization list. Responses use
`Cache-Control: no-store`.

| Status | Meaning / client action |
| --- | --- |
| `200` | Records for the watched hostnames; validate before use. |
| `400` | Invalid request; do not retry unchanged. |
| `401` | Missing or invalid account credential. |
| `429` | The account's check quota is used up; authorization is unknown. |
| `503` | Authorization data unavailable; authorization is unknown. |

The client rejects a malformed or expired document and any entry that covers
none of the submitted hostnames. It then applies the [lookup rule](#lookup-rule)
and the [local authorization gate](#local-authorization-gate) to the returned
records exactly as to a downloaded list, and reports with the response's
`version` as `watchlist_version`. A failure produces `unknown` and no report,
with bounded backoff (1 minute, doubling to at most 15).

The client keeps answers, including "not watched", in memory for at most one
hour and never beyond `expires`. It does not persist them, holds records of one
revision only, and asks again for all of a scan's hostnames when any is
unanswered, so one response covers the scan.

The operator authenticates the account and enforces a per-account quota (the
reference deployment: 30 requests per 5 minutes and 500 per UTC day), which
bounds how much of the list one account can discover by guessing hostnames. It
must not log or store the submitted hostnames, or use them for anything but the
answer.

**Privacy.** These checks are not anonymous. The operator receives the ad
hostnames an account saw on its searches, with the request's network address
and time, including hostnames of ads that are never reported. They do not use
reporting tokens or the relay. A partner using delegated domain checks
must disclose this recipient and linkage before consent
([`protocol.md` §1.1](protocol.md#11-informed-explicit-consent-before-enrollment)).
The trade is deliberate: the public no longer receives the operator's complete
list of protected domains and authorized advertisers.

## Publication

Serve the watchlist as public JSON over HTTPS, without requiring account
credentials or reporting tokens. Validate documents before publication and
preserve the source `version`, `published` and `expires` values when distributing
snapshots. An unavailable source must not extend a snapshot's lifetime. HTTP
caching must not outlive `expires`.

The [reference publisher](../registry/cloudflare/) implements scheduled snapshot
refreshes and returns `503` for missing, invalid or expired data. Its client
request path reads only the stored snapshot, so visitor headers are not forwarded
to the source. The client cache policy above applies independently of publisher
caching and replication delays.

## Size limits

The schema allows at most 10,000 entries. Each entry allows up to 10 brand terms,
50 authorized domains and 1,000 authorized advertiser IDs. The reference publisher
also limits the complete UTF-8 document to 1 MiB. A document must satisfy both
the schema and the publisher's byte limit.
