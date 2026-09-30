"""Explicit local demo. Production code should create_app(PrivacyTokenIssuer(...))."""

import hmac
import os
from fastapi import FastAPI, Request
from fray_token_issuer import DailyQuota, PrivacyTokenIssuer, create_app


def create_demo_app() -> FastAPI:
    token = os.environ.get("LOCAL_DEMO_TOKEN", "")
    if os.environ.get("FRAY_LOCAL_DEMO") != "1" or len(token) < 16:
        raise RuntimeError(
            "Local demo only: set FRAY_LOCAL_DEMO=1 and LOCAL_DEMO_TOKEN (at least 16 characters). Production must supply validate_user."
        )
    if os.environ.get("FRAY_ENV") == "production":
        raise RuntimeError("The mocked validate_user must not run in production")

    async def validate_user(request: Request) -> str | None:
        # LOCAL MOCK: replace with existing session/device authentication.
        # Return a stable internal quota subject, or None when validation fails.
        # A shared credential embedded in an extension is not user authentication.
        supplied = request.headers.get("authorization", "").encode()
        return (
            "local-demo-user"
            if hmac.compare_digest(supplied, f"Bearer {token}".encode())
            else None
        )

    issuer = PrivacyTokenIssuer(
        keys_dir=os.environ.get("KEYS_DIR", "./keys"),
        validate_user=validate_user,
        quota=DailyQuota(int(os.environ.get("DAILY_QUOTA", "64"))),
        max_batch=int(os.environ.get("MAX_BATCH", "64")),
    )
    return create_app(issuer)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        create_demo_app(),
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8083")),
        access_log=False,
    )
