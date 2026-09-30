"""Opaque RFC 9458 relay. No private keys, plaintext reports, cookies or access logs."""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit

from aiohttp import ClientError, ClientSession, ClientTimeout, DummyCookieJar, web

REQUEST_TYPE = "message/ohttp-req"
RESPONSE_TYPE = "message/ohttp-res"
KEYS_TYPE = "application/ohttp-keys"
MAX_MESSAGE_BYTES = 16 * 1024
MAX_KEY_BYTES = 4096
SAFE_ERRORS = {400, 401, 403, 413, 415, 429, 500, 502, 503, 504}
SESSION = web.AppKey("upstream_session", ClientSession)


@dataclass(frozen=True)
class Config:
    gateway_url: str
    keys_url: str | None = None
    allow_http: bool = False
    timeout_seconds: float = 10

    def endpoints(self) -> tuple[str, str]:
        def validate(value: str):
            url = urlsplit(value)
            if (
                url.scheme not in ({"https", "http"} if self.allow_http else {"https"})
                or not url.hostname
                or url.username
                or url.password
                or url.query
                or url.fragment
            ):
                raise ValueError(
                    "Upstream must be a fixed HTTPS URL without credentials, query, or fragment"
                )
            return url

        gateway = validate(self.gateway_url)
        keys = validate(
            self.keys_url
            or urlunsplit((gateway.scheme, gateway.netloc, "/ohttp-keys", "", ""))
        )
        if (gateway.scheme, gateway.netloc) != (keys.scheme, keys.netloc):
            raise ValueError("Gateway and keys must share an origin")
        return gateway.geturl(), keys.geturl()


def response(
    status: int, body: bytes = b"", content_type: str | None = None
) -> web.Response:
    headers = {
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
    }
    if content_type:
        headers["Content-Type"] = content_type
    return web.Response(status=status, body=body, headers=headers)


async def read_limited(message, limit: int) -> bytes:
    if message.content_length is not None and message.content_length > limit:
        raise web.HTTPRequestEntityTooLarge(
            max_size=limit, actual_size=message.content_length
        )
    result = bytearray()
    async for chunk in message.content.iter_chunked(4096):
        result.extend(chunk)
        if len(result) > limit:
            raise web.HTTPRequestEntityTooLarge(max_size=limit, actual_size=len(result))
    return bytes(result)


def create_app(config: Config) -> web.Application:
    gateway_url, keys_url = config.endpoints()
    silent_logger = logging.getLogger("fray.ohttp")
    silent_logger.disabled = True
    app = web.Application(
        client_max_size=MAX_MESSAGE_BYTES,
        logger=silent_logger,
        handler_args={
            "auto_decompress": False,
            "max_line_size": 8192,
            "max_field_size": 8192,
            "logger": silent_logger,
            "access_log": None,
        },
    )

    async def lifecycle(app):
        # No cookie persistence, environment proxy credentials or response decompression.
        async with ClientSession(
            timeout=ClientTimeout(total=config.timeout_seconds),
            cookie_jar=DummyCookieJar(),
            trust_env=False,
            auto_decompress=False,
            skip_auto_headers={"User-Agent", "Accept-Encoding"},
        ) as session:
            app[SESSION] = session
            yield

    app.cleanup_ctx.append(lifecycle)

    async def handle(request: web.Request) -> web.Response:
        if request.query_string:
            return response(404)
        if request.path == "/healthz" and request.method == "GET":
            return response(200, b"ok", "text/plain")
        is_keys = request.path == "/ohttp-keys"
        if not is_keys and request.path != "/ohttp":
            return response(404)
        if request.method == "OPTIONS":
            result = response(204)
            result.headers.update(
                {
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                    "Access-Control-Max-Age": "600",
                }
            )
            return result
        if request.method != ("GET" if is_keys else "POST"):
            return response(405)
        if not is_keys and (
            request.content_type != REQUEST_TYPE
            or "Content-Encoding" in request.headers
        ):
            return response(415)
        try:
            async with asyncio.timeout(config.timeout_seconds):
                raw = (
                    None if is_keys else await read_limited(request, MAX_MESSAGE_BYTES)
                )
            if raw == b"":
                return response(400)
        except web.HTTPRequestEntityTooLarge:
            return response(413)
        except (TimeoutError, ConnectionError):
            return response(408)
        expected = KEYS_TYPE if is_keys else RESPONSE_TYPE
        headers = {"Accept": expected}
        if not is_keys:
            headers["Content-Type"] = REQUEST_TYPE
        try:
            async with app[SESSION].request(
                "GET" if is_keys else "POST",
                keys_url if is_keys else gateway_url,
                headers=headers,
                data=raw,
                allow_redirects=False,
            ) as upstream:
                if upstream.status != 200:
                    return response(
                        upstream.status if upstream.status in SAFE_ERRORS else 502
                    )
                if (
                    upstream.content_type != expected
                    or "Content-Encoding" in upstream.headers
                ):
                    return response(502)
                body = await read_limited(
                    upstream, MAX_KEY_BYTES if is_keys else MAX_MESSAGE_BYTES
                )
                return response(200, body, expected) if body else response(502)
        except TimeoutError:
            return response(504)
        except (ClientError, ConnectionError, web.HTTPRequestEntityTooLarge):
            return response(502)

    app.router.add_route("*", "/{path:.*}", handle)
    return app


if __name__ == "__main__":
    web.run_app(
        create_app(
            Config(
                gateway_url=os.environ["GATEWAY_URL"],
                keys_url=os.environ.get("GATEWAY_KEYS_URL"),
                allow_http=os.environ.get("ALLOW_INSECURE_HTTP") == "true",
            )
        ),
        port=int(os.environ.get("PORT", "8788")),
        access_log=None,
        print=None,
    )
