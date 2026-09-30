# Watchlist format v1

The watchlist is the published, versioned list of watched brands.
The JSON format is `v: 1`; envelope versions have separate matching rules
below. Unmatched candidates are not looked up or submitted by the reporting flow.
Publishing the list makes the reporting scope visible to users and partners.

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
| `entries[].brand_terms`        | Lowercase brand mentions used by the v1 text rule. They do not trigger the v2 domain-only flow.                                                                                                 |
| `entries[].authorized_domains` | Domains that legitimately belong to the brand. Informational only: neither matcher suppresses a hit using this list, and v2 does not add these aliases to its match set. |
| `entries[].policy`             | Authorization completeness: `open` or absent cannot support an unlisted-identity report; `closed` declares a complete authorized ID list; `none` requires an explicit empty list for reporting.                                                              |
| `entries[].authorized_advertiser_ids` | Explicit Google advertiser ID allowlist (`AR` followed by 1–62 digits, matching the report contract). Missing means unknown authorizations, not an empty allowlist. |

Entry domains MUST be unique. `none` cannot contain authorized IDs. Clients must preserve policy and ID arrays in their validated cache. Lists without an explicit authorization array may support lookups but cannot authorize v2 reports.

## Lookup rule (envelope v2)

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

`brand_terms` alone never trigger v2. Other aliases in `authorized_domains` do not
become watched domains automatically; publish a corresponding primary entry if
an alias should be watched. `creative: null` is allowed only after the same domain
match, when a candidate exposes usable lookup data but no usable creative.

## Local authorization gate (envelope v2)

After Google returns an advertiser, evaluate its ID against the most specific matching entry. An authorized ID produces a local `authorized` result. A missing/malformed advertiser ID, missing authorization array, or absent/`open` policy produces `unknown`. Neither result is sent to Fray and neither consumes a report token.

Only a known ID absent from an explicit `closed` authorization list, or a known ID under `none` with an explicit empty list, produces `likely-unauthorized` and permits submission. The comparison happens locally and fails closed on incomplete data. It establishes an apparent authorization violation; investigation is still needed before calling an ad fraudulent.

Re-read the current cached policy after lookup and after any asynchronous token reservation. If the domain is removed, authorizations change, or the list expires, apply the new decision before sending. The host may display advertiser ID/name/country and the decision in its local UI. No lookup response or evaluation is persisted in the watchlist cache.

## Sighting match rule (envelope v1)

Fire when **either**:

1. The display-URL domain is `entries[].domain` or a subdomain of it; **or**
2. Any `brand_terms` value appears (case-insensitive, after Unicode NFKC folding) in
   the creative title or body.

Neither rule infers a destination or suppresses a hit using `authorized_domains`.

Then, and only then, the client builds an envelope with `brand = entries[].domain`.

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
