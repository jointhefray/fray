# Fray token issuer · TypeScript

Issue anonymous reporting tokens from your existing backend. Your `validateUser`
function decides who can draw tokens and your `metaFor` function supplies each
account's token metadata value. `PrivacyTokenIssuer` handles batch validation, daily
quotas, monthly keys and RFC 9474 blind signing (`RSABSSA-SHA384-PSS-Deterministic`).
It sees blinded messages, never the random token values that the client later submits
with a report.

Requires Node.js 24+. Package name: `@fray/token-issuer`.
The [Python implementation](../python/) has the same wire contract and key files.
See the [protocol](../../spec/protocol.md).

## Add it to your backend

After building this package, use it as a local dependency in your application.
This example assumes `authenticateSession` and `tokenMetaFor` are your application's
own functions:

```ts
import type { FastifyRequest } from 'fastify';
import { PrivacyTokenIssuer, buildServer } from '@fray/token-issuer';
import { authenticateSession, tokenMetaFor } from './auth.js';

const issuer = new PrivacyTokenIssuer<FastifyRequest>({
  keysDir: '/var/lib/fray/keys',
  validateUser: async (request) => {
    const session = await authenticateSession(request);
    return session?.subject ?? null;
  },
  metaFor: async (subject) => tokenMetaFor(subject),
});

const app = await buildServer(issuer);
await app.listen({ host: '127.0.0.1', port: 8081 });
```

`validateUser` returns a stable internal subject for the quota, or `null` to reject
the request. Check your real user/session/device credentials here. Do not trust a
caller-supplied user ID or a shared secret embedded in an extension. The callback
can be synchronous or asynchronous; a thrown error fails closed.

`metaFor(subject)` receives the subject that `validateUser` returned and returns the
account's current value, an integer from 0 to 3. The host's `metaFor` callback assigns
one of four issuer-defined values; their meaning is not published by the protocol.
Each epoch has four keys, one per value, and a token's value is whichever key signed
it, so:

- change an account's value at most once per epoch (UTC month);
- never let the value encode account identity, a timestamp or browsing activity: each
  value describes a coarse property shared by many accounts;
- disclose to users that tokens carry one of four issuer-defined values, which can
  affect whether reports are used.

See [protocol §4.1](../../spec/protocol.md#41-issuer-metadata). Anything other than an
integer from 0 to 3, or a thrown error, fails closed with `500`.

The service is independent of Fastify. With another framework, pass its request
context to `await issuer.meta(context)` and `await issuer.issue(context, body)`, and
expose `await issuer.publishKeys()` at the JWKS path. `await issuer.initialize()`
loads and checks the current month's four keys before serving traffic, and fails if
any is missing. Importing the package does not start a server or generate keys.

| Option | Default / contract |
| --- | --- |
| `keysDir` | Required directory of epoch keys made by the keygen command. |
| `validateUser(context)` | Required authentication callback; returns subject or `null`. |
| `metaFor(subject)` | Required; returns the account's value, an integer from 0 to 3. |
| `quota` | `new DailyQuota(16)`, an in-memory, single-process store. |
| `maxBatch` | 16; accepts integers from 1 to 16. |
| `clock()` | Current time; injectable for deterministic epoch/quota tests. |
| `onIssue(event)` | Writes JSON to stdout by default; optional sync/async audit sink. |

For production, inject a durable `QuotaStore` with
`take(subject, count, now): Promise<boolean>`. It must check the UTC-day limit and
reserve the **whole** batch atomically, returning `false` without changing usage
when it would exceed the limit. Redis can do this in a transaction or Lua script.
The default store loses counters on restart and does not coordinate replicas.
Limits above 16 are outside the protocol profile.

The issuer is otherwise stateless: a partner's only state is the monthly keys
(generated offline) and the per-account daily quota counter. Keys are read from disk
once per process; nothing else outlives a request.

## HTTP contract

| Request | Response |
| --- | --- |
| `GET /meta` with your client auth | `{"meta":n}`, with `Cache-Control: no-store`. |
| `POST /issue` with your client auth and `{"meta":n,"blinded":["<base64>","..."]}` | `{"kid":"ep-YYYY-MM.n","signatures":["<base64>","..."]}` in request order, with `Cache-Control: no-store`. |
| `GET /.well-known/jwks.json`, no auth | The current and existing previous UTC month's keys, four each. |

The client fetches `/meta`, blinds each message for the key `ep-YYYY-MM.n` of the
current epoch and posts the batch with the same value. `/issue` checks, in order:
authentication (`401`); the batch shape, the value and each blinded message's
encoding (`400` with `bad_request`, `bad_meta` or `bad_blinded`, including
noncanonical base64 and wrong lengths); that the value equals `metaFor`'s current
value (`409 {"error":"meta_mismatch"}`, after which the client refetches `/meta`
once); that each blinded integer is below that value's modulus (`400 bad_blinded`);
then the atomic quota reservation (`429`). A `409` consumes no quota. A month without
keys answers `503 {"error":"key_unavailable"}`. Every signature in a response comes
from the key named by `kid`. The HTTP adapter caps bodies at 64 KiB (`413`) and never
echoes internal errors. Failed signing or audit leaves the reservation spent, so a
retry cannot exceed the daily cap. Clients draw one batch of 16 tokens per UTC day
on a fixed schedule, independent of browsing.

The JWKS is public and the same document for every caller: no authentication, no
`Vary`, `Cache-Control: public, max-age=3600`. It lists the current epoch's keys
`ep-YYYY-MM.0` to `.3`, then the previous epoch's, each with `kty`, `n`, `e`, `kid`,
`use: "sig"` and `alg: "RSABSSA-SHA384-PSS-Deterministic"`. Keep it outside your
authentication layer and never vary it per caller: exactly four keys per epoch, the
same for everyone, is what lets anyone audit that no per-user keys exist.

## Keys

Generate each month's four keys offline, ahead of time:

```sh
npm run build
npm run keygen -- --keys-dir /var/lib/fray/keys --epoch next
```

`--epoch` takes `current`, `next` or `ep-YYYY-MM` and may repeat; the default is
`current`. `KEYS_DIR` can replace `--keys-dir`. For each epoch the command writes
`ep-YYYY-MM.N.rsabssa.key.pem` for N = 0 to 3 (mode-0600 PKCS#8, standard RSA-2048,
e = 65537, generated by OpenSSL off the event loop, about 0.1 s each) and
`ep-YYYY-MM.rsabssa.jwks.json`, the epoch's public keys. It generates only missing
keys and never replaces an existing one; files are written atomically. It prints each
modulus's SHA-256 so replicas can be compared, and never prints key material. The
[Python keygen](../python/) writes identical files.

The issuer never generates keys while serving. `initialize()` (and so
`buildServer()`) fails when any of the current month's four keys is missing, and
requests in a month without keys get `503`. Generate next month's keys during the
current month, for example from a monthly job, and give every replica the same files
so all of them publish the same JWKS.

Loading checks that every key is RSA-2048 with e = 65537, that the epoch has all four
and that no key is used for two values; anything else, or a corrupt file, fails
closed and is never replaced. The `.rsabssa.key.pem` names are distinct, so keys from
other schemes or earlier versions are never loaded: never rename another key into this
scheme. Use a persistent local filesystem supporting atomic hard links, and dedicated
keys.

## Signing

Each blinded message is signed with the private key for the request's value, using
OpenSSL's raw RSA private operation (CRT with RSA blinding, `privateDecrypt` with
`RSA_NO_PADDING`). Nothing is derived per request. PSS encoding, blinding and
finalization stay client-side.

Fault protection ([protocol §2](../../spec/protocol.md#2-cryptographic-suite)) is
OpenSSL's internal check: inside the private operation it raises the CRT result to e
mod n, compares it with the input and recomputes without CRT on a mismatch, so a
faulty CRT half is never returned. The issuer therefore does not repeat the check
with `publicEncrypt`. A test injects a CRT fault (a corrupted `dp` or `dq`) into each
of the four keys and fails if the output is not m^d mod n computed with `BigInt`. If
it ever fails after an OpenSSL or Node upgrade, add an explicit s^e mod n check to
`blindSign` before deploying.

On a developer laptop (Node 24, OpenSSL 3.5.8): 0.35 ms per signature, so a 16-token
`/issue` request takes about 6 ms. `@cloudflare/blindrsa-ts` is used only by the
tests, as the client and as a reference signer.

Audit events contain only `ts`, `event`, `client`, `count`, `epoch`. Do not add
credentials, request headers, blinded messages or token values to logs. The subject
stays with your issuer and is not part of the issued token or report.

## Run the local example

[src/example.ts](src/example.ts) is a small server with visibly mocked `validateUser`
and `metaFor` hooks. It has no default credential and requires explicit demo opt-in.
Replace both hooks and use your own entrypoint before deployment.

```sh
npm ci
FRAY_LOCAL_DEMO=1 LOCAL_DEMO_TOKEN=local-example-token npm run dev
```

The demo listens on `127.0.0.1:8081`. Authenticate with
`Authorization: Bearer local-example-token`. Every accepted demo request shares
one quota subject and gets the value in `LOCAL_DEMO_META` (0 to 3, default 0). For
convenience, the demo generates the current month's keys if they are missing; a
production issuer never does. `NODE_ENV=production` refuses the mock.
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

## Verify

```sh
npm run typecheck
npm test
npm run build
```

Tests use the committed TEST ONLY keys and the RFC 9474 Appendix A.3 vector in
[../test-fixtures](../test-fixtures/). They check the vector, byte equality with
`@cloudflare/blindrsa-ts` `blindSign`, that a token from one value's key fails
verification under every other key, the fault check and the HTTP contract.
`test/interop.test.ts` drives the Python issuer through its test-only stdio bridge and
finalizes and verifies its signatures with `@cloudflare/blindrsa-ts`. It needs
`../python/.venv` (or `FRAY_INTEROP_PYTHON`) and is skipped without it.

MIT OR Apache-2.0. Copyright 2026 Marcode Ltd.
[MIT](../../LICENSE-MIT) · [Apache 2.0](../../LICENSE-APACHE)
