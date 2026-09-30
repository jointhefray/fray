# Node relay and gateway

Requires Node.js 24; the Docker image uses Node.js 24. Install and check:

```sh
npm ci
npm test
npm run build
```

## Relay

```sh
GATEWAY_URL=https://gateway.example.org/ohttp npm start
```

The relay listens on port 8788. `GATEWAY_KEYS_URL` optionally overrides the public-key route, but must use the same origin as `GATEWAY_URL`. Both URLs must be HTTPS, without credentials, query strings or fragments. `ALLOW_INSECURE_HTTP=true` permits HTTP for a local demonstration only. `PORT` overrides the listening port.

## Gateway

Generate private keys once, into a private directory:

```sh
mkdir -p keys
npm run keygen -- ./keys/gateway-keys.json
OHTTP_KEY_FILE=./keys/gateway-keys.json \
  COLLECTOR_URL=https://collector.example.org/v1/events \
  npm run start:gateway
```

The gateway listens on port 8789. Keep the collector behind the gateway's network boundary. Its public-key endpoint contains only serialized public keys; never serve the JSON key file. A successful submission returns an encrypted empty HTTP 200; the collector's acceptance diagnostics stay private.

`COLLECTOR_URL` is the exact `/v1/events` endpoint. The gateway ignores client and relay metadata and supplies `country: "ZZ"`. The virtual inner address is always `https://collector.fray.invalid/submit`, not the configured collector address.

## Docker

Build from this directory:

```sh
docker build -t fray-ohttp .
docker run --rm -p 8788:8788 \
  -e GATEWAY_URL=https://gateway.example.org/ohttp fray-ohttp
```

For a gateway, prepare a persistent key volume and use the gateway command:

```sh
docker volume create fray-ohttp-keys
docker run --rm -v fray-ohttp-keys:/app/keys fray-ohttp \
  node dist/keygen.js /app/keys/gateway-keys.json
docker run --rm -p 8789:8789 \
  -v fray-ohttp-keys:/app/keys:ro \
  -e OHTTP_KEY_FILE=/app/keys/gateway-keys.json \
  -e COLLECTOR_URL=https://collector.example.org/v1/events \
  fray-ohttp node dist/gateway-server.js
```

Both services run as the unprivileged `node` user. The key volume is created with that user's ownership. Key generation refuses to replace an existing file; subsequent starts reuse the saved keys.

See the [OHTTP overview](../README.md) for the trust model, key authentication and extension client API.

## Temporary inbound sink on Heroku

The `inbound` service is an OHTTP gateway that decrypts a bounded report and
discards it. It validates the inner method, fixed target, headers, JSON object and
8064-byte limit using the existing gateway. It makes no collector request, verifies
no tokens, writes no report data, and has no database dependency. Its generic
encrypted HTTP 200 means the request reached the sink; it does not mean a report
was retained or accepted by a collector. Invalid logical requests receive encrypted
errors, and malformed outer requests fail before decryption.

Deploy **this directory as the Heroku application root**, with its `package.json`,
`package-lock.json`, `Procfile`, `tsconfig.json` and `src/` directory. The Node.js
buildpack installs dependencies and runs `heroku-postbuild` (`npm run build`). The
`Procfile` starts `node dist/inbound-server.js` on Heroku's assigned `PORT`, binding
to `0.0.0.0`. `npm start` continues to run the standalone relay; `npm run start:inbound`
runs this sink locally. Use Node.js 24 and set `NODE_ENV=production`.

Generate gateway keys **once**, on a trusted machine:

```sh
npm ci
npm run build
mkdir -p keys
node dist/keygen.js ./keys/inbound-keys.json
```

Set the complete JSON file contents as the secret Heroku config variable
`OHTTP_KEYS_JSON` before starting the web dyno. Do not commit that file, paste it
into logs, or regenerate keys at dyno startup. Config variables persist across
dyno replacement; the dyno filesystem is ephemeral. The service refuses to start
without valid keys and never exposes private material through its public routes.
Key arrays support distinct IDs for a planned rotation overlap.

| Route | Behavior |
| --- | --- |
| `POST /ohttp` | Decode a bounded encrypted report, discard it, return encrypted empty HTTP 200. |
| `GET /ohttp-keys` | Publish RFC-formatted public configuration only. |
| `GET /healthz` | Return `ok` for process liveness. |

For `inbound.jointhefray.org`, configure a Heroku custom domain with TLS and a
DNS-only record. The Cloudflare Worker at `ohttp.jointhefray.org` must forward to
`https://inbound.jointhefray.org/ohttp`; its TLS socket cannot connect to a
Cloudflare-proxied gateway. Authenticate or pin the published public configuration
in clients. The application logs no report bodies or client IPs; platform router
logging is controlled outside this process. Hosting both sides under the same
operator does not establish independent relay/gateway operation.
