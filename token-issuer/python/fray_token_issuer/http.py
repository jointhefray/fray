"""Optional FastAPI adapter. Importing it does not create keys or start a server."""

import json
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from .issuer import IssuanceError, PrivacyTokenIssuer


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
            {"error": error.code},
            status_code=error.status,
            headers={"cache-control": "no-store"},
        )

    @app.exception_handler(Exception)
    async def internal_error(_request: Request, _error: Exception):
        return JSONResponse(
            {"error": "internal_error"},
            status_code=500,
            headers={"cache-control": "no-store"},
        )

    @app.post("/issue")
    async def issue(request: Request):
        # Bound the bytes read, including chunked requests; never echo invalid input.
        raw = bytearray()
        async for chunk in request.stream():
            if len(raw) + len(chunk) > 64 * 1024:
                return JSONResponse(
                    {"error": "bad_request"},
                    status_code=413,
                    headers={"cache-control": "no-store"},
                )
            raw.extend(chunk)
        try:
            body = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            raise IssuanceError(400, "bad_request") from None
        try:
            result = await issuer.issue(request, body)
        except IssuanceError:
            raise
        except Exception:
            # Consume unexpected auth/signing errors here. ASGI's generic error
            # handler re-raises them to the server, which may log secret details.
            return JSONResponse(
                {"error": "internal_error"},
                status_code=500,
                headers={"cache-control": "no-store"},
            )
        return JSONResponse(result, headers={"cache-control": "no-store"})

    @app.get("/.well-known/jwks.json")
    async def jwks():
        return JSONResponse(
            await issuer.publish_keys(),
            headers={"cache-control": "public, max-age=3600"},
        )

    return app
