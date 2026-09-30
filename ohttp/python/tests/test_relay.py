import asyncio
import unittest

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from relay import Config, MAX_MESSAGE_BYTES, REQUEST_TYPE, RESPONSE_TYPE, create_app


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
        self.relay = TestClient(
            TestServer(
                create_app(
                    Config(
                        str(self.gateway.make_url("/ohttp")),
                        allow_http=True,
                        timeout_seconds=0.2,
                    )
                )
            )
        )
        await self.relay.start_server()

    async def asyncTearDown(self):
        await self.relay.close()
        await self.gateway.close()

    async def post(self, body=b"encrypted-request", headers=None, path="/ohttp"):
        return await self.relay.post(
            path, data=body, headers={"Content-Type": REQUEST_TYPE, **(headers or {})}
        )

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
            {"host", "accept", "content-type", "content-length"},
        )

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
        result = await self.relay.get("/ohttp-keys", headers={"Cookie": "identity"})
        self.assertEqual(result.status, 200)
        self.assertEqual(self.seen[0][0], "/ohttp-keys")
        self.assertNotIn("Cookie", self.seen[0][1])

    async def test_redirect_wrong_media_and_huge_response_fail_closed(self):
        self.status = 302
        self.assertEqual((await self.post()).status, 502)
        self.assertEqual(len(self.seen), 1)
        self.status = 200
        self.response_type = "application/json"
        self.assertEqual((await self.post()).status, 502)
        self.response_type = RESPONSE_TYPE
        self.reply_body = b"x" * (MAX_MESSAGE_BYTES + 1)
        self.assertEqual((await self.post()).status, 502)

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
                create_app(Config(gateway))


if __name__ == "__main__":
    unittest.main()
