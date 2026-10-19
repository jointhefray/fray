# Fray token issuer · Python

Issue anonymous reporting tokens from your existing Python backend. Supply a
`validate_user` callback and a `meta_for` callback; `PrivacyTokenIssuer` handles batch
validation, quotas, monthly keys and RFC 9474 blind signing
(`RSABSSA-SHA384-PSS-Deterministic`). The [TypeScript package](../typescript/)
implements the same [protocol](../../spec/protocol.md), wire contract and key files.

Requires Python 3.11+. Package name: `fray-token-issuer`.
Importing it does not generate keys or start a server.

## Add it to your backend

Use `python -m pip install .` to install the local package. This example assumes
`authenticate_session` and `token_meta_for` are your application's own functions:

```python
from fastapi import Request
from fray_token_issuer import PrivacyTokenIssuer, create_app
from your_app.auth import authenticate_session, token_meta_for

async def validate_user(request: Request) -> str | None:
    session = await authenticate_session(request)
    return session.subject if session else None

async def meta_for(subject: str) -> int:
    return await token_meta_for(subject)

issuer = PrivacyTokenIssuer(
    keys_dir="/var/lib/fray/keys", validate_user=validate_user, meta_for=meta_for
)
app = create_app(issuer)
```

Return a stable internal quota subject, or `None` to reject authentication. Validate
real session/device credentials; a caller-supplied user ID or shared credential
embedded in an extension is not authentication. Sync and async callbacks are
supported; errors fail closed. Keep synchronous callbacks nonblocking.

`meta_for(subject)` receives the subject that `validate_user` returned and returns the
account's current value, an integer from 0 to 3. The host's `meta_for` callback
assigns one of four issuer-defined values; their meaning is not published by the
protocol. Each epoch has four keys, one per value, and a token's value is whichever
key signed it, so:

- change an account's value at most once per epoch (UTC month);
- never let the value encode account identity, a timestamp or browsing activity: each
  value describes a coarse property shared by many accounts;
- disclose to users that tokens carry one of four issuer-defined values, which can
  affect whether reports are used.

See [protocol §4.1](../../spec/protocol.md#41-issuer-metadata). Anything other than an
integer from 0 to 3 (booleans included), or a raised error, fails closed with `500`.

The service can run behind another framework: `await issuer.initialize()`,
`await issuer.meta(context)`, `await issuer.issue(context, body)` and
`await issuer.publish_keys()` are the public API. `initialize()` loads and checks the
current month's four keys and fails if any is missing. Key loading and signing run
in worker threads, outside the event loop.

| Option | Default / contract |
| --- | --- |
| `keys_dir` | Required directory of epoch keys made by the keygen command. |
| `validate_user(context)` | Required; returns subject or `None`, optionally awaitable. |
| `meta_for(subject)` | Required; returns an integer from 0 to 3, optionally awaitable. |
| `quota` | `DailyQuota(16)`, in memory for a single process. |
| `max_batch` | 16; accepts integers from 1 to 16. |
| `clock()` | Current UTC time; custom clocks must return aware datetimes. |
| `on_issue(event)` | JSON to stdout by default; optional sync/async audit sink. |

Production requires a durable `QuotaStore.take(subject, count, when)` implementation.
It must check the UTC-day limit and reserve the whole batch atomically, returning
`False` without changing usage if the batch exceeds the limit. It may return an
awaitable boolean. The in-memory default loses counters on restart and does not
coordinate replicas. Limits above 16 are outside the protocol profile.

The issuer is otherwise stateless: a partner's only state is the monthly keys
(generated offline) and the per-account daily quota counter. Keys are read from disk
once per process; nothing else outlives a request.

## HTTP contract

`GET /meta`, with your client auth, returns `{"meta":n}` with `Cache-Control: no-store`.
`POST /issue`, with your client auth, accepts `{"meta":n,"blinded":["<base64>","..."]}`
and returns `{"kid":"ep-YYYY-MM.n","signatures":["<base64>","..."]}` in request order,
with `Cache-Control: no-store`. `GET /.well-known/jwks.json` takes no authentication
and publishes the current and existing previous month's keys, four each.

The client fetches `/meta`, blinds each message for the key `ep-YYYY-MM.n` of the
current epoch and posts the batch with the same value. `/issue` checks, in order:
authentication (`401`); the batch shape, the value and each blinded message's
encoding (`400` with `bad_request`, `bad_meta` or `bad_blinded`, including
noncanonical base64 and wrong lengths); that the value equals `meta_for`'s current
value (`409 {"error":"meta_mismatch"}`, after which the client refetches `/meta`
once); that each blinded integer is below that value's modulus (`400 bad_blinded`);
then the atomic quota reservation (`429`). A `409` consumes no quota. A month without
keys answers `503 {"error":"key_unavailable"}`. The adapter caps request bodies at
64 KiB (`413`), including chunked bodies, and does not echo internal errors. Signing
or audit failure leaves the quota reserved, so retries cannot exceed the daily cap.
Clients draw one batch of 16 tokens per UTC day on a fixed schedule, independent of
browsing.

The JWKS is the same document for every caller: no authentication, no `Vary`,
`Cache-Control: public, max-age=3600`. It lists the current epoch's keys
`ep-YYYY-MM.0` to `.3`, then the previous epoch's, each with `kty`, `n`, `e`, `kid`,
`use: "sig"` and `alg: "RSABSSA-SHA384-PSS-Deterministic"`. Keep it outside your
authentication layer and never vary it per caller.

## Keys

Generate each month's four keys offline, ahead of time:

```sh
python -m fray_token_issuer.keygen --keys-dir /var/lib/fray/keys --epoch next
```

The installed package also provides this as `fray-token-issuer-keygen`. `--epoch`
takes `current`, `next` or `ep-YYYY-MM` and may repeat; the default is `current`.
`KEYS_DIR` can replace `--keys-dir`. For each epoch the command writes
`ep-YYYY-MM.N.rsabssa.key.pem` for N = 0 to 3 (mode-0600 PKCS#8, standard RSA-2048,
e = 65537, from PyCryptodome, typically well under a second each) and
`ep-YYYY-MM.rsabssa.jwks.json`, the epoch's public keys. It generates only missing
keys and never replaces an existing one; files are written atomically. It prints each
modulus's SHA-256 so replicas can be compared, and never prints key material. The
[TypeScript keygen](../typescript/) writes identical files.

The issuer never generates keys while serving. `initialize()` (and so app startup)
fails when any of the current month's four keys is missing, and requests in a month
without keys get `503`. Generate next month's keys during the current month and give
every replica the same files so all of them publish the same JWKS.

Loading checks that every key is RSA-2048 with e = 65537, that the epoch has all four
and that no key is used for two values; anything else, or a corrupt file, fails
closed and is never replaced. The `.rsabssa.key.pem` names are distinct, so keys from
other schemes or earlier versions are never loaded: never rename another key into this
scheme. Atomic no-replace hard links stop concurrent writers from replacing an
existing key. Use a persistent local filesystem supporting atomic hard links, and
dedicated keys.

## Signing

Each blinded message is signed with the private key for the request's value, using
RSA blinding (a fresh random r per signature) and CRT. The exponentiations use `pow()`
on PyCryptodome's `Integer` (GMP when available, otherwise PyCryptodome's Montgomery
code). The `cryptography` package exposes no raw RSA private operation, so the
signer does not go through OpenSSL. PSS encoding, blinding and finalization stay
client-side.

Fault protection ([protocol §2](../../spec/protocol.md#2-cryptographic-suite)): this
signer computes CRT itself and nothing checks it internally, so every signature goes
through an explicit RSAVP1 check, s^e mod n must equal the blinded message, before it
is returned. With e = 65537 the check is cheap. A faulty CRT half would reveal a
factor of n; a test corrupts `dp` and `dq` and requires the check to refuse. Never
remove it.

On a developer laptop with GMP: 0.9 ms per signature including the check, so a
16-token `/issue` request takes about 14 ms (1.5 ms per signature and about 25 ms
without GMP). PyCryptodome is pinned (`3.23.0`); recheck the RFC 9474 vector and the
interoperability tests before upgrading. This implementation has not undergone an
independent cryptographic audit.

Audit events contain only `ts`, `event`, `client`, `count`, `epoch`. Do not log
credentials, headers, blinded messages or token values. The subject remains with
your issuer; it does not appear in tokens or reports.

## Run the local example

[app.py](app.py) demonstrates the mocked `validate_user` and `meta_for` integration
points. It has no default credential and requires explicit local opt-in. Replace the
hooks and use your own application entrypoint before deployment.

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-dev.txt
FRAY_LOCAL_DEMO=1 LOCAL_DEMO_TOKEN=local-example-token python app.py
```

The demo listens on `127.0.0.1:8083`. Authenticate with
`Authorization: Bearer local-example-token`; all demo requests share one subject and
get the value in `LOCAL_DEMO_META` (0 to 3, default 0). For convenience, the demo
generates the current month's keys if they are missing; a production issuer never
does. `FRAY_ENV=production` refuses the mock. For an ASGI factory:
`uvicorn app:create_demo_app --factory --no-access-log --port 8083` with the same
environment. See [.env.example](.env.example).

```sh
docker build -t fray-token-issuer-python .
docker run --rm -p 127.0.0.1:8083:8083 \
  -e FRAY_LOCAL_DEMO=1 -e LOCAL_DEMO_TOKEN=local-example-token \
  -v fray-python-keys:/app/keys fray-token-issuer-python
```

The container runs the same local example as an unprivileged user. Production
images should supply your integration and persist keys and quota state.

## Verify

```sh
python -m pytest -q
python -m mypy
```

Tests use the committed TEST ONLY keys and the RFC 9474 Appendix A.3 vector in
[../test-fixtures](../test-fixtures/). A test-only client blinds and finalizes with its
own RFC 8017 PSS encoding and verifies with the independent RSA-PSS verifier in
`cryptography`; production clients should use a maintained implementation such as
`@cloudflare/blindrsa-ts`. `test_interop.py` drives the TypeScript issuer through its
test-only stdio bridge and verifies its signatures here; it needs `npm ci` in
`../typescript` and is skipped without it. The TypeScript tests run the reverse
direction through [interop_bridge.py](interop_bridge.py), finalizing and verifying
this package's signatures with `@cloudflare/blindrsa-ts`.

MIT OR Apache-2.0. Copyright 2026 Marcode Ltd.
[MIT](../../LICENSE-MIT) · [Apache 2.0](../../LICENSE-APACHE)
