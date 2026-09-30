# Public Fray registry on Cloudflare

`GET /v1/watchlist.json` publishes a public domain and authorized-advertiser
watchlist. The Worker stores validated public snapshots. Its API provides no
token issuance, report submission or account operations.

A Cron Trigger fetches a fixed upstream source every 15 minutes. Public GET and HEAD
requests read KV only; a missing snapshot never triggers an upstream fetch.
Consequently visitor headers and identity are not forwarded to the source. The
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
continue serving the previous valid revision until its original expiry. Client
caching can further delay revision updates and must respect the document's expiry.

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

## Seed and deploy

The example configuration contains no production account, custom domain or KV
namespace. Create a namespace in your own Cloudflare account:

```sh
npx wrangler kv namespace create REGISTRY
```

Replace the all-zero `id` under `kv_namespaces` with the returned namespace ID.
Set your account and custom-domain route in `wrangler.toml`. The `REGISTRY`
namespace must contain public snapshots only; its single key is `watchlist:v1`.

Set the `UPSTREAM_URL` Worker variable under `[vars]` in `wrangler.toml` to your
trusted public watchlist source, such as `https://publisher.example.org/watchlist.json`.
It must use HTTPS without credentials, a query string or a fragment, and serve
documents matching `spec/watchlist.schema.json`. Missing or invalid configuration
fails refreshes before any outbound request; there is no default source. Public
requests cannot select or change the source.

Prepare a fresh, validated source document in a new temporary file; this command
does not change KV or deploy anything:

```sh
UPSTREAM_URL=https://publisher.example.org/watchlist.json \
  npm run prepare-seed -- /tmp/fray-registry-seed.json
```

The seed command reads `UPSTREAM_URL` from its process environment; use the same
URL as the Worker variable. It creates the file exclusively and prints only the
revision and expiry. Upload that exact file and deploy promptly before it expires:

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
