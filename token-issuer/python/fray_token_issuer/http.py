"""Optional FastAPI adapter. Importing it does not create keys or start a server."""

import json
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from .issuer import IssuanceError, PrivacyTokenIssuer

NO_STORE = {"cache-control": "no-store"}


async def _respond(
    operation: Callable[[], Awaitable[Any]], headers: dict[str, str]
) -> JSONResponse:
    try:
        result = await operation()
    except IssuanceError as error:
        return JSONResponse(
            {"error": error.code}, status_code=error.status, headers=NO_STORE
        )
    except Exception:
        # Consume unexpected auth/metadata/signing errors here. ASGI's generic error
        # handler re-raises them to the server, which may log secret details.
        return JSONResponse(
            {"error": "internal_error"}, status_code=500, headers=NO_STORE
        )
    return JSONResponse(result, headers=headers)


def create_app(issuer: PrivacyTokenIssuer[Request]) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await issuer.initialize()
        yield

    app = FastAPI(
        title="Fray privacy token issuer",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )

    @app.exception_handler(IssuanceError)
    async def issuance_error(_request: Request, error: IssuanceError):
        return JSONResponse(
            {"error": error.code}, status_code=error.status, headers=NO_STORE
        )

    @app.exception_handler(Exception)
    async def internal_error(_request: Request, _error: Exception):
        return JSONResponse(
            {"error": "internal_error"}, status_code=500, headers=NO_STORE
        )

    @app.post("/issue")
    async def issue(request: Request):
        # Bound the bytes read, including chunked requests; never echo invalid input.
        raw = bytearray()
        async for chunk in request.stream():
            if len(raw) + len(chunk) > 64 * 1024:
                return JSONResponse(
                    {"error": "bad_request"}, status_code=413, headers=NO_STORE
                )
            raw.extend(chunk)
        try:
            body = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            return JSONResponse(
                {"error": "bad_request"}, status_code=400, headers=NO_STORE
            )
        return await _respond(lambda: issuer.issue(request, body), NO_STORE)

    @app.get("/meta")
    async def meta(request: Request):
        return await _respond(lambda: issuer.meta(request), NO_STORE)

    # Public and unauthenticated: the same document for every caller, with no Vary on auth.
    @app.get("/.well-known/jwks.json")
    async def jwks():
        return await _respond(
            issuer.publish_keys, {"cache-control": "public, max-age=3600"}
        )

    return app
