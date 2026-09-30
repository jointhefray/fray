# Python OHTTP relay

This is an opaque relay, compatible with the TypeScript gateway and extension transport. Python never decrypts the report or holds gateway keys.

Requires Python 3.11 or later:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests -v
GATEWAY_URL=https://gateway.example.org/ohttp .venv/bin/python relay.py
```

Or build from this directory:

```sh
docker build -t fray-ohttp-python .
docker run --rm -p 8788:8788 \
  -e GATEWAY_URL=https://gateway.example.org/ohttp fray-ohttp-python
```

`PORT` defaults to 8788. `GATEWAY_KEYS_URL` optionally sets the fixed key endpoint on the gateway's origin. HTTPS is required unless `ALLOW_INSECURE_HTTP=true` is explicitly set for a local demo.

The relay forwards only `Accept`, `Content-Type`, and the HTTP client's required host/length fields. It ignores proxy environment variables, stores no cookies, disables decompression and access logging, and never follows redirects. The same [limits and HTTP contract](../README.md#contract) apply as the other relay implementations.

Use separate relay and gateway operators, and disable access/body logs in any surrounding reverse proxy. See the [OHTTP overview](../README.md) for key authentication and remaining operational work.
