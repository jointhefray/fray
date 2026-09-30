# Fray token issuer · Python

Issue anonymous reporting tokens from your existing Python backend. Supply a
`validate_user` callback; `PrivacyTokenIssuer` handles batch validation, quotas,
monthly keys and RFC 9474 blind signing. The [TypeScript package](../typescript/)
implements the same [protocol](../../spec/protocol.md).

Requires Python 3.11+. The local package is `fray-token-issuer`; no PyPI publication
is implied. Importing it does not generate keys or start a server.

## Add it to your backend

Use `python -m pip install .` to install the local package. This example assumes
`authenticate_session` is your application's existing authentication function:

```python
from fastapi import Request
from fray_token_issuer import PrivacyTokenIssuer, create_app
from your_app.auth import authenticate_session

async def validate_user(request: Request) -> str | None:
    session = await authenticate_session(request)
    return session.subject if session else None

issuer = PrivacyTokenIssuer(keys_dir="/var/lib/fray/keys", validate_user=validate_user)
app = create_app(issuer)
```

Return a stable internal quota subject, or `None` to reject authentication. Validate
real session/device credentials; a caller-supplied user ID or shared credential
embedded in an extension is not authentication. Sync and async callbacks are
supported; errors fail closed. Keep synchronous callbacks nonblocking.

The service can run behind another framework:
`await issuer.initialize()`, `await issuer.issue(context, body)` and
`await issuer.publish_keys()` are the public API. CPU-bound key generation and
signing run in worker threads, outside the event loop.

| Option | Default / contract |
| --- | --- |
| `keys_dir` | Required persistent directory for epoch keys. |
| `validate_user(context)` | Required; returns subject or `None`, optionally awaitable. |
| `quota` | `DailyQuota(64)`, in memory for a single process. |
| `max_batch` | 64; accepts integers from 1 to 64. |
| `clock()` | Current UTC time; custom clocks must return aware datetimes. |
| `on_issue(event)` | JSON to stdout by default; optional sync/async audit sink. |

Production requires a durable `QuotaStore.take(subject, count, when)` implementation.
It must check the UTC-day limit and reserve the whole batch atomically, returning
`False` without changing usage if the batch exceeds the limit. It may return an
awaitable boolean. The in-memory default loses counters on restart and does not
coordinate replicas. Limits above 64 are outside the protocol profile.

## HTTP contract

`POST /issue` accepts `{"blinded":["<base64>","..."]}` and returns
`{"kid":"ep-YYYY-MM","signatures":["<base64>","..."]}` in request order.
`GET /.well-known/jwks.json` publishes current and existing previous month keys.

Invalid batches, noncanonical base64, wrong modulus lengths and out-of-range
integers return `400`; rejected authentication `401`; exhausted quotas `429`.
The adapter caps request bodies at 64 KiB (`413`), including chunked bodies, and
does not echo internal errors. Validation precedes quota reservation. Signing or
audit failure leaves the quota reserved, so retries cannot exceed the daily cap.
Clients normally draw 32 tokens on a fixed daily schedule, independent of browsing;
the 64-token daily quota allows one catch-up batch.

## Run the local example

[app.py](app.py) demonstrates the mocked `validate_user` integration point. It has
no default credential and requires explicit local opt-in. Replace the hook and
use your own application entrypoint before deployment.

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-dev.txt
FRAY_LOCAL_DEMO=1 LOCAL_DEMO_TOKEN=local-example-token python app.py
```

The demo listens on `127.0.0.1:8083`. Authenticate with
`Authorization: Bearer local-example-token`; all demo requests share one subject.
`FRAY_ENV=production` refuses the mock. For an ASGI factory:
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

## Signing and key storage

The suite is `RSABSSA-SHA384-PSS-Deterministic`: RSA-2048, SHA-384, MGF1-SHA-384,
48-byte PSS salt, with client-generated 32-byte random token messages. The issuer
performs a raw RSA private operation and the RFC 9474 public self-check; all PSS
encoding is client-side.

The signing adapter in [issuer.py](fray_token_issuer/issuer.py) uses
[`PyCryptodome 3.23.0`'s raw private operation](https://github.com/Legrandin/pycryptodome/blob/v3.23.0/lib/Crypto/PublicKey/RSA.py),
which applies RSA blinding. This is an **internal library API**, isolated and pinned
because the public RSA signing API adds its own encoding. Recheck the adapter and
interoperability tests before upgrading. This implementation has not undergone an independent cryptographic audit.

Private keys persist as mode-0600 `ep-YYYY-MM.key.pem` PKCS#8 files, compatible with
the TypeScript issuer. Public keys are derived from the private key files. Atomic no-replace hard links prevent concurrent writers
from replacing an existing epoch key. Corrupt/unreadable keys fail closed. Use a
persistent local filesystem supporting atomic hard links, and dedicated keys.

Audit events contain only `ts`, `event`, `client`, `count`, `epoch`. Do not log
credentials, headers, blinded messages or token values. The subject remains with
your issuer; it does not appear in tokens or reports.

## Verify

```sh
python -m pytest -q
python -m mypy
```

Tests perform client-side blinding and finalization, then verify with the independent
RSA-PSS verifier in `cryptography`. Test-only PSS encoding follows RFC 8017;
production clients should use a maintained RFC 9474 implementation such as
`@cloudflare/blindrsa-ts`, following the [token contract](../../spec/protocol.md#2-cryptographic-suite).
Tests also cover auth rejection, validation without quota loss, concurrent quotas,
UTC rollover, key races, persisted keys and current/previous epoch JWKS publication.

MIT OR Apache-2.0. Copyright 2026 Marcode Ltd.
[MIT](../../LICENSE-MIT) · [Apache 2.0](../../LICENSE-APACHE)
