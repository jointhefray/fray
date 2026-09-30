"""Authentication and quota policy around RFC 9474 BlindSign."""

import asyncio
import base64
import binascii
import inspect
import json
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Generic, TypeVar
from Crypto.PublicKey import RSA
from .keys import EpochKeys
from .quota import DailyQuota, QuotaStore

Context = TypeVar("Context")
AuditEvent = dict[str, str | int]


class IssuanceError(Exception):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


def _sign_batch(key: RSA.RsaKey, messages: list[bytes]) -> list[str]:
    signatures = []
    for message in messages:
        value = int.from_bytes(message, "big")
        # RFC 9474 §4.2. This isolated adapter uses PyCryptodome 3.23.0's
        # internal raw private operation (with RSA blinding), not Python pow(d).
        # Its dependency is pinned; upgrades require these interoperability tests.
        signature = key._decrypt_to_bytes(value)  # type: ignore[attr-defined]
        if (
            len(signature) != key.size_in_bytes()
            or pow(int.from_bytes(signature, "big"), key.e, key.n) != value
        ):
            raise RuntimeError("blind signing self-check failed")
        signatures.append(base64.b64encode(signature).decode())
    return signatures


class PrivacyTokenIssuer(Generic[Context]):
    def __init__(
        self,
        *,
        keys_dir: str | Path,
        validate_user: Callable[[Context], str | None | Awaitable[str | None]],
        quota: QuotaStore | None = None,
        max_batch: int = 64,
        clock: Callable[[], datetime] | None = None,
        on_issue: Callable[[AuditEvent], None | Awaitable[None]] | None = None,
    ):
        if not callable(validate_user):
            raise ValueError("validate_user is required")
        if type(max_batch) is not int or not 1 <= max_batch <= 64:
            raise ValueError("max_batch must be an integer from 1 to 64")
        self._keys = EpochKeys(keys_dir)
        self._validate_user = validate_user
        self._quota = quota if quota is not None else DailyQuota()
        self._max_batch = max_batch
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._on_issue = on_issue

    def _now(self) -> datetime:
        now = self._clock()
        if now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("clock must return a timezone-aware datetime")
        return now.astimezone(timezone.utc)

    async def initialize(self) -> None:
        """Warm the current epoch key before accepting requests."""
        await asyncio.to_thread(self._keys.current, self._now())

    async def publish_keys(self) -> dict[str, list[dict[str, str]]]:
        return await asyncio.to_thread(self._keys.publish, self._now())

    async def issue(self, context: Context, body: object) -> dict[str, object]:
        """Validate identity and the entire batch before reserving any quota."""
        validated = self._validate_user(context)
        client = await validated if inspect.isawaitable(validated) else validated
        if not isinstance(client, str) or not client.strip():
            raise IssuanceError(401, "unauthorized")
        blinded = body.get("blinded") if isinstance(body, dict) else None
        if not isinstance(blinded, list) or not 1 <= len(blinded) <= self._max_batch:
            raise IssuanceError(400, "bad_request")
        now = self._now()
        kid, key = await asyncio.to_thread(self._keys.current, now)
        encoded_length = 4 * ((key.size_in_bytes() + 2) // 3)
        messages = []
        for value in blinded:
            if not isinstance(value, str) or len(value) != encoded_length:
                raise IssuanceError(400, "bad_blinded")
            try:
                raw = base64.b64decode(value, validate=True)
            except (ValueError, binascii.Error):
                raise IssuanceError(400, "bad_blinded") from None
            if (
                len(raw) != key.size_in_bytes()
                or base64.b64encode(raw).decode() != value
                or not 0 < int.from_bytes(raw, "big") < key.n
            ):
                raise IssuanceError(400, "bad_blinded")
            messages.append(raw)
        reservation = self._quota.take(client, len(messages), now)
        allowed = await reservation if inspect.isawaitable(reservation) else reservation
        if not allowed:
            raise IssuanceError(429, "quota_exceeded")
        signatures = await asyncio.to_thread(_sign_batch, key, messages)
        # Failed signing/audit leaves quota reserved; retries cannot exceed the cap.
        event: AuditEvent = {
            "ts": now.isoformat(),
            "event": "issue",
            "client": client,
            "count": len(signatures),
            "epoch": kid,
        }
        if self._on_issue is None:
            print(json.dumps(event), flush=True)
        else:
            audit = self._on_issue(event)
            if inspect.isawaitable(audit):
                await audit
        return {"kid": kid, "signatures": signatures}
