# Python OHTTP relay

This opaque relay forwards reports to a separately operated receiving gateway following the [OHTTP transport profile](../../spec/relay.md). Python never decrypts the report or holds gateway private keys.

Requires Python 3.11 or later:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests -v
# FRAY_RELAY_AUTH comes from your secret store; never commit or log it.
GATEWAY_URL=https://gateway.example.org/ohttp FRAY_RELAY_AUTH="$FRAY_RELAY_AUTH" \
  .venv/bin/python relay.py
```

Or build from this directory:

```sh
docker build -t fray-ohttp-python .
docker run --rm -p 8788:8788 \
  -e GATEWAY_URL=https://gateway.example.org/ohttp \
  -e FRAY_RELAY_AUTH fray-ohttp-python
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `GATEWAY_URL` | Yes | The gateway's HTTPS `/ohttp` endpoint. |
| `FRAY_RELAY_AUTH` | Yes | Shared secret sent as `Fray-Relay-Auth`, 32–512 base64/base64url characters. The gateway operator must accept the same value. The relay refuses to start without a valid value. |
| `FRAY_COUNTRY_HEADER` | No | Header that a trusted proxy in front of the relay sets **and overwrites**, such as `CF-IPCountry`. Unset → every report is `ZZ`. Leave it unset if clients can bypass that proxy. `Fray-*` names are refused. |
| `GATEWAY_KEYS_URL` | No | Fixed key endpoint on the gateway's origin. |
| `ALLOW_INSECURE_HTTP` | No | `true` permits HTTP upstreams for a local demo only. |
| `PORT` | No | Listening port (default 8788). |

The relay forwards only `Accept`, `Content-Type`, the HTTP client's required host/length fields, and the derived `Fray-Country`, `Fray-Device` and `Fray-Relay-Auth` headers. It reads `Sec-CH-UA-Platform`, `User-Agent` and the configured country header to derive them, and copies none of them. Gateway responses pass through unchanged: the encrypted body byte for byte, and a plain error status such as 503, 429 or 403 as that status without its body. Derivation matches the TypeScript relay; both are tested against [`../test-vectors/relay-metadata.json`](../test-vectors/relay-metadata.json). It ignores proxy environment variables, stores no cookies, disables decompression and access logging, and never follows redirects. The same [limits and HTTP contract](../README.md#contract) apply as the other relay implementations.

Use separate relay and gateway operators, and disable access/body logs in any surrounding reverse proxy. See the [OHTTP overview](../README.md) for key authentication and remaining operational work.
