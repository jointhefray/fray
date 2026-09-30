# Public Fray registry on Cloudflare

`https://registry.jointhefray.org/v1/watchlist.json` publishes the existing public
domain and authorized-advertiser watchlist. This Worker stores public snapshots
only. It never receives or stores tokens, sightings, account credentials or
per-user registry data.

A Cron Trigger fetches the fixed source
`https://adpocalypse.net/fray/watchlist.json` every 15 minutes. Public GET and HEAD
requests read KV only; a missing snapshot never triggers an upstream fetch.
Consequently visitor headers and identity are not forwarded to the issuer. The
scheduled request has only a fixed URL and an `Accept: application/json` header.
Cloudflare still handles visitor connections to this public endpoint; this is
not an anonymous transport.

An independent validator checks the public watchlist schema. A public-field allowlist,
1 MiB body bound, UTF-8 validation and 10-second download limit apply before a
snapshot is saved. Redirects, HTTP errors, malformed data, expired source data
and revision regressions do not replace the previous snapshot. The validated
document is serialized again before publication; all source field values,
including `version`, `published` and `expires`, remain unchanged. The Worker never
extends an expiry or returns an expired document.

GET/HEAD return `503` with `no-store` if KV is unavailable, empty, invalid or
expired. Successful responses permit caching for at most five minutes and never
past source expiry, with `must-revalidate`. CORS allows public GET/HEAD/OPTIONS.
`GET /healthz` is liveness only, independent of KV freshness. Other paths return
404 and other methods return 405. There is no public refresh or write endpoint.

KV is eventually consistent; locations may briefly see different valid
revisions. Every response independently checks expiry. A failed refresh can
continue serving the previous valid revision until its original expiry. SDK
clients separately cache a list for up to 24 hours, bounded by that expiry, so
the publication schedule does not promise immediate client updates.

## Build and test

Use Node 24 or later. No runtime npm dependencies are needed. The validator in
`src/watchlist.ts` implements the public `spec/watchlist.schema.json` format;
this package has no extension SDK dependency.

```sh
cd registry/cloudflare
npm ci
npm run typecheck
npm test
npm run build
```

## Initial seed and deployment

The example configuration contains no production account, custom domain or KV
namespace. Create a namespace in your own Cloudflare account:

```sh
npx wrangler kv namespace create REGISTRY
```

Replace the all-zero `id` under `kv_namespaces` with the returned namespace ID.
Set your account and custom-domain route in `wrangler.toml`. The `REGISTRY`
namespace must contain public snapshots only; its single key is `watchlist:v1`.
The fixed refresh source is the public Fray feed at
`https://adpocalypse.net/fray/watchlist.json`; change the source constant and test
its schema compatibility if operating a different registry.

Prepare a fresh, validated source document in a new temporary file; this command
does not change KV or deploy anything:

```sh
npm run prepare-seed -- /tmp/fray-registry-seed.json
```

It creates the file exclusively and prints only the revision and expiry. Upload
that exact file and deploy promptly before the document expires:

```sh
npx wrangler kv key put --binding REGISTRY --remote watchlist:v1 --path /tmp/fray-registry-seed.json
npm run deploy
```

The seed is the validated JSON document, without a wrapper, fetched-at timestamp,
or new expiry. Do not substitute an example or regenerate its dates. The normal
HTTP read path validates seeded data too and fails closed on invalid/expired
files. Reusing a stale local seed can roll back KV, so always prepare a new file.

The Worker Custom Domain provisions its DNS record and certificate. The config
disables `workers.dev`, preview URLs and Worker observability. Cron configuration
may take several minutes to propagate; seeding avoids waiting for the first run.
Once deployed, verify the public document's version/expiry and `/healthz`. A
successful health check alone does not prove the scheduled refresh is healthy.
