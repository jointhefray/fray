"""Explicit local demo. Production code should create_app(PrivacyTokenIssuer(...))."""

import hmac
import os
import re
import sys
from datetime import datetime, timezone
from fastapi import FastAPI, Request
from fray_token_issuer import (
    DailyQuota,
    PrivacyTokenIssuer,
    create_app,
    epoch_id,
    generate_epoch_keys,
)


def create_demo_app() -> FastAPI:
    token = os.environ.get("LOCAL_DEMO_TOKEN", "")
    if os.environ.get("FRAY_LOCAL_DEMO") != "1" or len(token) < 16:
        raise RuntimeError(
            "Local demo only: set FRAY_LOCAL_DEMO=1 and LOCAL_DEMO_TOKEN (at least 16 characters). Production must supply validate_user."
        )
    if os.environ.get("FRAY_ENV") == "production":
        raise RuntimeError("The mocked validate_user must not run in production")
    # The demo assigns one fixed issuer-defined value to every request.
    meta_text = os.environ.get("LOCAL_DEMO_META", "0")
    if not re.fullmatch(r"[0-3]", meta_text):
        raise RuntimeError("LOCAL_DEMO_META must be 0, 1, 2 or 3")
    demo_meta = int(meta_text)
    keys_dir = os.environ.get("KEYS_DIR", "./keys")

    # LOCAL DEMO convenience: create this month's four keys if they are missing. A
    # production issuer never generates keys while serving; run the keygen command ahead.
    generated = generate_epoch_keys(keys_dir, epoch_id(datetime.now(timezone.utc)))
    if generated.created:
        print(
            f"LOCAL DEMO generated {', '.join(generated.created)} in {keys_dir}.",
            file=sys.stderr,
            flush=True,
        )

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

    def meta_for(_subject: str) -> int:
        # LOCAL MOCK: replace with your own assignment of one of the four
        # issuer-defined values.
        return demo_meta

    issuer = PrivacyTokenIssuer(
        keys_dir=keys_dir,
        validate_user=validate_user,
        meta_for=meta_for,
        quota=DailyQuota(int(os.environ.get("DAILY_QUOTA", "16"))),
        max_batch=int(os.environ.get("MAX_BATCH", "16")),
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
