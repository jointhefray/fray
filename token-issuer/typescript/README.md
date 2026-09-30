# Fray token issuer · TypeScript

Issue anonymous reporting tokens from your existing backend. Your `validateUser`
function decides who can draw tokens; `PrivacyTokenIssuer` handles batch validation,
daily quotas, monthly keys and RFC 9474 blind signing. It sees blinded messages,
never the random token values that the client later submits with a report.

Requires Node.js 24+. Package name: `@fray/token-issuer` (local source package;
no npm publication is implied). The [Python implementation](../python/) has the
same wire contract. See the [protocol](../../spec/protocol.md).

## Add it to your backend

After building this package, use it as a local dependency in your application.
This example assumes `authenticateSession` is your application's existing auth:

```ts
import type { FastifyRequest } from 'fastify';
import { PrivacyTokenIssuer, buildServer } from '@fray/token-issuer';
import { authenticateSession } from './auth.js';

const issuer = new PrivacyTokenIssuer<FastifyRequest>({
  keysDir: '/var/lib/fray/keys',
  validateUser: async (request) => {
    const session = await authenticateSession(request);
    return session?.subject ?? null;
  },
});

const app = await buildServer(issuer);
await app.listen({ host: '127.0.0.1', port: 8081 });
```

`validateUser` returns a stable internal subject for the quota, or `null` to reject
the request. Check your real user/session/device credentials here. Do not trust a
caller-supplied user ID or a shared secret embedded in an extension. The callback
can be synchronous or asynchronous; a thrown error fails closed.

The service is independent of Fastify. With another framework, pass its request
context to `await issuer.issue(context, body)`, and expose
`await issuer.publishKeys()` at the JWKS path. `await issuer.initialize()` warms the
current key before serving traffic. Importing the package does not start a server.

| Option | Default / contract |
| --- | --- |
| `keysDir` | Required persistent directory for epoch keys. |
| `validateUser(context)` | Required authentication callback; returns subject or `null`. |
| `quota` | `new DailyQuota(64)`, an in-memory, single-process store. |
| `maxBatch` | 64; accepts integers from 1 to 64. |
| `clock()` | Current time; injectable for deterministic epoch/quota tests. |
| `onIssue(event)` | Writes JSON to stdout by default; optional sync/async audit sink. |

For production, inject a durable `QuotaStore` with
`take(subject, count, now): Promise<boolean>`. It must check the UTC-day limit and
reserve the **whole** batch atomically, returning `false` without changing usage
when it would exceed the limit. Redis can do this in a transaction or Lua script.
The default store loses counters on restart and does not coordinate replicas.
Limits above 64 are outside the protocol profile.

## HTTP contract

| Request | Response |
| --- | --- |
| `POST /issue` with `{"blinded":["<base64>","..."]}` | `{"kid":"ep-YYYY-MM","signatures":["<base64>","..."]}` in request order. |
| `GET /.well-known/jwks.json` | Current and existing previous UTC-month public keys only. |

Issuance returns `400` for an invalid batch or noncanonical base64, wrong modulus
length or out-of-range integer; `401` for rejected authentication; `429` for an
exhausted quota. The HTTP adapter caps bodies at 64 KiB (`413`) and never echoes
internal errors. Validation precedes quota reservation. Failed signing or audit
leaves the reservation spent, so a retry cannot exceed the daily cap.
Clients normally draw 32 tokens on a fixed daily schedule, independent of browsing;
the 64-token daily quota allows one catch-up batch.

## Run the local example

[src/example.ts](src/example.ts) is a small server with a visibly mocked
`validateUser` hook. It has no default credential and requires explicit demo opt-in.
Replace that hook and use your own entrypoint before deployment.

```sh
npm ci
FRAY_LOCAL_DEMO=1 LOCAL_DEMO_TOKEN=local-example-token npm run dev
```

The demo listens on `127.0.0.1:8081`. Authenticate with
`Authorization: Bearer local-example-token`. Every accepted demo request shares
one quota subject. `NODE_ENV=production` refuses the mock.
See [.env.example](.env.example) for the optional host, port, key and quota settings.

```sh
docker build -t fray-token-issuer-ts .
docker run --rm -p 127.0.0.1:8081:8081 \
  -e FRAY_LOCAL_DEMO=1 -e LOCAL_DEMO_TOKEN=local-example-token \
  -v fray-ts-keys:/app/keys fray-token-issuer-ts
```

The Dockerfile runs the same local example as an unprivileged user. Production
images should replace its entrypoint with your integration and persist both keys
and quota state. Keep the demo's published port bound to loopback.

## Keys and signing

The suite is `RSABSSA-SHA384-PSS-Deterministic`: RSA-2048, SHA-384, MGF1-SHA-384,
48-byte PSS salt, and no message randomizer. The client prepares and blinds its
fresh 32-byte nonce. Signing uses Node's native raw RSA private operation and the
RFC 9474 public self-check; it never PSS-signs the blinded bytes as a new message.
Tests use `@cloudflare/blindrsa-ts` to blind, finalize and verify the result.

Keys live in `ep-YYYY-MM.key.pem` as mode-0600 PKCS#8 files. The public key is
derived from the private key. A completed
key file is published with an atomic, no-replace hard link so concurrent starts
load the same winner. Corrupt or unreadable keys fail closed. Use a persistent
local filesystem supporting atomic hard links, and dedicated keys for this protocol.

Audit events contain only `ts`, `event`, `client`, `count`, `epoch`. Do not add
credentials, request headers, blinded messages or token values to logs. The subject
stays with your issuer and is not part of the issued token or report.

## Verify

```sh
npm run typecheck
npm test
npm run build
```

Tests cover real blind → issue → finalize → verify, auth rejection, malformed and
oversized batches, atomic concurrent quotas, UTC rollover, persisted keys,
concurrent key creation, and current/previous epoch JWKS publication.

MIT OR Apache-2.0. Copyright 2026 Marcode Ltd.
[MIT](../../LICENSE-MIT) · [Apache 2.0](../../LICENSE-APACHE)
