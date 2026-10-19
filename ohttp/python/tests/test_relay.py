import asyncio
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from relay import (
    MAX_MESSAGE_BYTES,
    MAX_RESPONSE_BYTES,
    REQUEST_TYPE,
    RESPONSE_TYPE,
    Config,
    create_app,
    derive_device,
    normalize_country,
)

HERE = Path(__file__).resolve().parent
# Shared with the TypeScript relay and the Cloudflare Worker.
VECTORS = json.loads(
    (HERE.parents[1] / "test-vectors" / "relay-metadata.json").read_text("utf-8")
)
# Synthetic, test-only value in the accepted secret format.
RELAY_SECRET = "test-only-relay-secret-".ljust(44, "A")
MAC_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


class DerivationTests(unittest.TestCase):
    def test_country_table(self):
        for case in VECTORS["country"]:
            self.assertEqual(
                normalize_country(case["input"]), case["expected"], case["input"]
            )

    def test_device_table(self):
        for case in VECTORS["device"]:
            self.assertEqual(
                derive_device(case["platform"], case["userAgent"]),
                case["expected"],
                case["name"],
            )

    def test_relay_secret_is_required_and_never_echoed(self):
        for value in [None, "", "weak-value-do-not-print", RELAY_SECRET + " x"]:
            with self.assertRaises(ValueError) as caught:
                create_app(Config("https://gateway.example/ohttp", relay_auth=value))
            self.assertIn("FRAY_RELAY_AUTH", str(caught.exception))
            if value:
                self.assertNotIn(value, str(caught.exception))

    def test_trusted_country_header_cannot_be_a_fray_header(self):
        for name in ["Fray-Country", "fray-anything", "CF IPCountry", "Country:"]:
            with self.assertRaises(ValueError):
                create_app(
                    Config(
                        "https://gateway.example/ohttp",
                        relay_auth=RELAY_SECRET,
                        country_header=name,
                    )
                )

    def test_server_refuses_to_start_without_secret(self):
        for extra in [{}, {"FRAY_RELAY_AUTH": "weak-value-do-not-print"}]:
            env = {
                "PATH": os.environ.get("PATH", ""),
                "GATEWAY_URL": "https://gateway.example/ohttp",
                **extra,
            }
            result = subprocess.run(
                [sys.executable, "relay.py"],
                cwd=HERE.parent,
                env=env,
                capture_output=True,
                text=True,
                timeout=20,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("FRAY_RELAY_AUTH must be set", result.stderr)
            self.assertNotIn("weak-value-do-not-print", result.stderr)


class RelayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.seen = []
        self.status = 200
        self.response_type = RESPONSE_TYPE
        self.reply_body = b"encrypted-response"
        self.delay = 0

        async def gateway(request):
            self.seen.append(
                (request.path, dict(request.headers), await request.read())
            )
            await asyncio.sleep(self.delay)
            return web.Response(
                status=self.status,
                body=self.reply_body,
                headers={
                    "Content-Type": (
                        "application/ohttp-keys"
                        if request.path == "/ohttp-keys"
                        else self.response_type
                    ),
                    "Set-Cookie": "tracking=identifier",
                    "Location": "https://attacker.example/",
                },
            )

        upstream = web.Application()
        upstream.router.add_route("*", "/{path:.*}", gateway)
        self.gateway = TestServer(upstream)
        await self.gateway.start_server()
        self.relay = await self.start_relay()
        self.relays = [self.relay]

    async def start_relay(self, country_header=None):
        relay = TestClient(
            TestServer(
                create_app(
                    Config(
                        str(self.gateway.make_url("/ohttp")),
                        allow_http=True,
                        timeout_seconds=0.2,
                        relay_auth=RELAY_SECRET,
                        country_header=country_header,
                    )
                )
            )
        )
        await relay.start_server()
        return relay

    async def asyncTearDown(self):
        for relay in self.relays:
            await relay.close()
        await self.gateway.close()

    async def post(
        self, body=b"encrypted-request", headers=None, path="/ohttp", relay=None
    ):
        return await (relay or self.relay).post(
            path,
            data=body,
            headers={"Content-Type": REQUEST_TYPE, **(headers or {})},
            # Only headers the test names reach the relay.
            skip_auto_headers={"User-Agent"},
        )

    def forwarded(self, index=-1):
        return {key.lower(): value for key, value in self.seen[index][1].items()}

    async def test_forwards_bytes_and_discards_identity_headers_and_response_cookies(
        self,
    ):
        result = await self.post(
            headers={
                "Cookie": "user=one",
                "Authorization": "Bearer identity",
                "Forwarded": "for=192.0.2.1",
                "X-Forwarded-For": "192.0.2.1",
                "CF-Connecting-IP": "192.0.2.1",
                "Traceparent": "tracking",
                "User-Agent": "private-browser",
                "Referer": "https://secret.example/path",
            }
        )
        self.assertEqual(result.status, 200)
        self.assertEqual(await result.read(), b"encrypted-response")
        self.assertNotIn("Set-Cookie", result.headers)
        self.assertNotIn("Location", result.headers)
        path, headers, body = self.seen[0]
        self.assertEqual(path, "/ohttp")
        self.assertEqual(body, b"encrypted-request")
        self.assertEqual(
            set(key.lower() for key in headers),
            {
                "host",
                "accept",
                "content-type",
                "content-length",
                "fray-country",
                "fray-device",
                "fray-relay-auth",
            },
        )
        self.assertEqual(self.forwarded()["fray-relay-auth"], RELAY_SECRET)

    async def test_forwards_derived_metadata_never_client_headers(self):
        relay = await self.start_relay(country_header="CF-IPCountry")
        self.relays.append(relay)
        result = await self.post(
            headers={
                "CF-IPCountry": "GB",
                "User-Agent": MAC_UA,
                "Sec-CH-UA-Platform": '"macOS"',
                "Sec-CH-UA": '"Chromium";v="126"',
                "Fray-Country": "US",
                "Fray-Device": "ios-mobile",
                "Fray-Relay-Auth": "client-supplied-".ljust(40, "x"),
                "Fray-Anything": "injected",
            },
            relay=relay,
        )
        self.assertEqual(result.status, 200)
        headers = self.forwarded()
        self.assertEqual(headers["fray-country"], "GB")
        self.assertEqual(headers["fray-device"], "macos-desktop")
        self.assertEqual(headers["fray-relay-auth"], RELAY_SECRET)
        for name in ["user-agent", "sec-ch-ua", "sec-ch-ua-platform", "cf-ipcountry"]:
            self.assertNotIn(name, headers)
        self.assertEqual(
            sorted(name for name in headers if name.startswith("fray-")),
            ["fray-country", "fray-device", "fray-relay-auth"],
        )

    async def test_country_is_zz_without_trusted_header(self):
        await self.post(headers={"CF-IPCountry": "GB"})
        self.assertEqual(self.forwarded()["fray-country"], "ZZ")

    async def test_country_vectors_through_trusted_header(self):
        relay = await self.start_relay(country_header="X-Geo-Country")
        self.relays.append(relay)
        for case in VECTORS["country"]:
            headers = {} if case["input"] is None else {"X-Geo-Country": case["input"]}
            result = await self.post(headers=headers, relay=relay)
            self.assertEqual(result.status, 200)
            self.assertEqual(
                self.forwarded()["fray-country"], case["expected"], case["input"]
            )

    async def test_device_vectors_through_relay(self):
        for case in VECTORS["device"]:
            headers = {}
            if case["platform"] is not None:
                headers["Sec-CH-UA-Platform"] = case["platform"]
            if case["userAgent"] is not None:
                headers["User-Agent"] = case["userAgent"]
            result = await self.post(headers=headers)
            self.assertEqual(result.status, 200)
            self.assertEqual(
                self.forwarded()["fray-device"], case["expected"], case["name"]
            )
            self.assertNotIn("user-agent", self.forwarded())

    async def test_accepts_largest_encapsulated_request(self):
        self.assertEqual(MAX_MESSAGE_BYTES, 655360)
        result = await self.post(b"x" * MAX_MESSAGE_BYTES)
        self.assertEqual(result.status, 200)
        self.assertEqual(len(self.seen[-1][2]), MAX_MESSAGE_BYTES)

    async def test_rejects_invalid_or_large_requests_before_upstream(self):
        for body, headers, status in [
            (b"", {}, 400),
            (b"x" * (MAX_MESSAGE_BYTES + 1), {}, 413),
            (b"{}", {"Content-Type": "application/json"}, 415),
            (b"x", {"Content-Encoding": "gzip"}, 415),
        ]:
            result = await self.post(body, headers)
            self.assertEqual(result.status, status)
            await result.release()
        self.assertEqual(self.seen, [])

    async def test_streamed_body_size_limit(self):
        async def body():
            yield b"x" * MAX_MESSAGE_BYTES
            yield b"x"

        result = await self.post(body())
        self.assertEqual(result.status, 413)
        self.assertEqual(self.seen, [])

    async def test_fixed_route_and_keys(self):
        result = await self.post(path="/ohttp?url=https://attacker.example/")
        self.assertEqual(result.status, 404)
        result = await self.relay.get(
            "/ohttp-keys", headers={"Cookie": "identity", "Fray-Country": "US"}
        )
        self.assertEqual(result.status, 200)
        self.assertEqual(self.seen[0][0], "/ohttp-keys")
        self.assertNotIn("Cookie", self.seen[0][1])
        # Key discovery carries no metadata and no relay secret.
        self.assertFalse(
            any(key.lower().startswith("fray-") for key in self.seen[0][1])
        )

    async def test_redirect_wrong_media_and_huge_response_fail_closed(self):
        self.status = 302
        self.assertEqual((await self.post()).status, 502)
        self.assertEqual(len(self.seen), 1)
        self.status = 200
        self.response_type = "application/json"
        self.assertEqual((await self.post()).status, 502)
        self.response_type = RESPONSE_TYPE
        self.reply_body = b"x" * (MAX_RESPONSE_BYTES + 1)
        self.assertEqual((await self.post()).status, 502)

    async def test_passes_gateway_unavailable_status_through_without_body(self):
        # An encrypted inner 503 arrives as an outer 200 and is relayed byte for byte
        # (see the first test); a plain 503 or 429 keeps its status and loses its body.
        for status in [503, 429]:
            self.status = status
            self.reply_body = b"private diagnostics"
            result = await self.post()
            self.assertEqual(result.status, status)
            self.assertEqual(await result.read(), b"")

    async def test_timeout_fails_closed(self):
        self.delay = 0.4
        self.assertEqual((await self.post()).status, 504)

    def test_requires_secure_fixed_configuration(self):
        for gateway in [
            "http://example.org/ohttp",
            "https://user:pass@example.org/ohttp",
            "https://example.org/ohttp?target=x",
        ]:
            with self.assertRaises(ValueError):
                create_app(Config(gateway, relay_auth=RELAY_SECRET))


if __name__ == "__main__":
    unittest.main()
