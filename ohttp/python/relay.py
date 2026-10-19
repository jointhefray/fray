"""Opaque RFC 9458 relay. No private keys, plaintext reports, cookies or access logs."""

from __future__ import annotations

import asyncio
import logging
import os
import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit, urlunsplit

from aiohttp import ClientError, ClientSession, ClientTimeout, DummyCookieJar, web

REQUEST_TYPE = "message/ohttp-req"
RESPONSE_TYPE = "message/ohttp-res"
KEYS_TYPE = "application/ohttp-keys"
# Encapsulated request limit (spec/relay.md); the gateway only returns an encrypted empty status.
MAX_MESSAGE_BYTES = 655360
MAX_RESPONSE_BYTES = 16 * 1024
MAX_KEY_BYTES = 4096
SAFE_ERRORS = {400, 401, 403, 413, 415, 429, 500, 502, 503, 504}
SESSION = web.AppKey("upstream_session", ClientSession)

# Mirrors ohttp/typescript/src/metadata.ts; shared vectors in ohttp/test-vectors.
UNKNOWN_COUNTRY = "ZZ"
UNKNOWN_DEVICE = "other"
PLATFORMS = {
    "Android": "android-mobile",
    "iOS": "ios-mobile",
    "macOS": "macos-desktop",
    "Windows": "windows-desktop",
    "Linux": "linux-desktop",
    "Chrome OS": "chromeos-desktop",
    "ChromeOS": "chromeos-desktop",
}
# Checked in this order; the first matching substring wins.
USER_AGENTS = (
    (("Android",), "android-mobile"),
    (("iPhone", "iPad", "iPod"), "ios-mobile"),
    (("CrOS",), "chromeos-desktop"),
    (("Windows NT",), "windows-desktop"),
    (("Macintosh", "Mac OS X"), "macos-desktop"),
    (("Linux",), "linux-desktop"),
)
ALPHA2 = re.compile(r"[A-Za-z]{2}")
# RFC 6750 b64token: a valid header value without list commas.
SECRET = re.compile(r"[A-Za-z0-9\-._~+/]+=*")
MIN_SECRET_LENGTH = 32
MAX_SECRET_LENGTH = 512
HEADER_NAME = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")


def normalize_country(value: str | None) -> str:
    """Uppercase ISO 3166-1 alpha-2. Tor (T1), unknown (XX), missing or malformed → ZZ."""
    if not isinstance(value, str):
        return UNKNOWN_COUNTRY
    value = value.strip()
    # Validate ASCII before uppercasing: Unicode case mapping turns "ß" into "SS".
    if not ALPHA2.fullmatch(value):
        return UNKNOWN_COUNTRY
    value = value.upper()
    return UNKNOWN_COUNTRY if value == "XX" else value


def derive_device(platform: str | None, user_agent: str | None) -> str:
    """Sec-CH-UA-Platform when it maps to a known platform, else User-Agent, else other."""
    if platform is not None:
        value = platform.strip()
        if len(value) >= 2 and value.startswith('"') and value.endswith('"'):
            value = value[1:-1]
        if value in PLATFORMS:
            return PLATFORMS[value]
    if user_agent is not None:
        for needles, device in USER_AGENTS:
            if any(needle in user_agent for needle in needles):
                return device
    return UNKNOWN_DEVICE


def header(headers, name: str) -> str | None:
    """Combined field value, as Fetch's Headers.get returns it."""
    values = headers.getall(name, [])
    return ", ".join(values) if values else None


def is_relay_secret(value) -> bool:
    return (
        isinstance(value, str)
        and MIN_SECRET_LENGTH <= len(value) <= MAX_SECRET_LENGTH
        and SECRET.fullmatch(value) is not None
    )


@dataclass(frozen=True)
class Config:
    gateway_url: str
    keys_url: str | None = None
    allow_http: bool = False
    timeout_seconds: float = 10
    # Shared secret sent as Fray-Relay-Auth. Required: the relay refuses to start without it.
    relay_auth: str | None = field(default=None, repr=False)
    # Header that a fronting proxy sets and overwrites (e.g. CF-IPCountry). None → ZZ.
    country_header: str | None = None

    def validated_secret(self) -> str:
        if not is_relay_secret(self.relay_auth):
            # Never include the configured value.
            raise ValueError(
                f"FRAY_RELAY_AUTH must be set to a shared secret of {MIN_SECRET_LENGTH}-"
                f"{MAX_SECRET_LENGTH} base64/base64url characters"
            )
        return self.relay_auth

    def validated_country_header(self) -> str | None:
        name = self.country_header
        if not name:
            return None
        if not HEADER_NAME.fullmatch(name) or name.lower().startswith("fray-"):
            raise ValueError(
                "FRAY_COUNTRY_HEADER must be a header name set by a trusted proxy"
            )
        return name

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
    # Fail closed: never send unauthenticated metadata, and never send ciphertext without it.
    relay_auth = config.validated_secret()
    country_header = config.validated_country_header()
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
        # Built from scratch: no client header, including Fray-*, is ever copied.
        headers = {"Accept": expected}
        if not is_keys:
            headers.update(
                {
                    "Content-Type": REQUEST_TYPE,
                    "Fray-Country": normalize_country(
                        header(request.headers, country_header)
                        if country_header
                        else None
                    ),
                    "Fray-Device": derive_device(
                        header(request.headers, "Sec-CH-UA-Platform"),
                        header(request.headers, "User-Agent"),
                    ),
                    "Fray-Relay-Auth": relay_auth,
                }
            )
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
                    upstream, MAX_KEY_BYTES if is_keys else MAX_RESPONSE_BYTES
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
                relay_auth=os.environ.get("FRAY_RELAY_AUTH"),
                country_header=os.environ.get("FRAY_COUNTRY_HEADER"),
            )
        ),
        port=int(os.environ.get("PORT", "8788")),
        access_log=None,
        print=None,
    )
