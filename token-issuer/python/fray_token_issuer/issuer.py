"""Authentication, metadata and quota policy around RFC 9474 BlindSign."""

import asyncio
import base64
import binascii
import inspect
import json
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Generic, TypeVar
from .keys import EpochKeys, KeyUnavailableError
from .rsabssa import SigningKey, blind_sign, is_token_meta
from .quota import DailyQuota, QuotaStore

Context = TypeVar("Context")
AuditEvent = dict[str, str | int]


class IssuanceError(Exception):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


def _sign_batch(key: SigningKey, messages: list[bytes]) -> list[str]:
    return [base64.b64encode(blind_sign(key, message)).decode() for message in messages]


class PrivacyTokenIssuer(Generic[Context]):
    def __init__(
        self,
        *,
        keys_dir: str | Path,
        validate_user: Callable[[Context], str | None | Awaitable[str | None]],
        meta_for: Callable[[str], int | Awaitable[int]],
        quota: QuotaStore | None = None,
        max_batch: int = 16,
        clock: Callable[[], datetime] | None = None,
        on_issue: Callable[[AuditEvent], None | Awaitable[None]] | None = None,
    ):
        if not callable(validate_user):
            raise ValueError("validate_user is required")
        if not callable(meta_for):
            raise ValueError("meta_for is required")
        if type(max_batch) is not int or not 1 <= max_batch <= 16:
            raise ValueError("max_batch must be an integer from 1 to 16")
        self._keys = EpochKeys(keys_dir)
        self._validate_user = validate_user
        self._meta_for = meta_for
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
        """Load and check the current epoch's four keys before serving; fails if any is missing."""
        await asyncio.to_thread(self._keys.current, self._now())

    async def publish_keys(self) -> dict[str, list[dict[str, str]]]:
        """Exactly the current and, if present, previous month keys. No authentication."""
        return await asyncio.to_thread(self._keys.publish, self._now())

    async def _authenticate(self, context: Context) -> str:
        validated = self._validate_user(context)
        client = await validated if inspect.isawaitable(validated) else validated
        if not isinstance(client, str) or not client.strip():
            raise IssuanceError(401, "unauthorized")
        return client

    async def _meta_of(self, subject: str) -> int:
        assigned = self._meta_for(subject)
        meta = await assigned if inspect.isawaitable(assigned) else assigned
        if not is_token_meta(meta):
            raise ValueError("meta_for must return an integer from 0 to 3")
        return int(meta)

    async def meta(self, context: Context) -> dict[str, int]:
        """The authenticated account's current metadata value."""
        return {"meta": await self._meta_of(await self._authenticate(context))}

    async def issue(self, context: Context, body: object) -> dict[str, object]:
        """Validate identity, value and the entire batch before reserving any quota."""
        client = await self._authenticate(context)
        request = body if isinstance(body, dict) else {}
        blinded = request.get("blinded")
        if not isinstance(blinded, list) or not 1 <= len(blinded) <= self._max_batch:
            raise IssuanceError(400, "bad_request")
        meta = request.get("meta")
        if not is_token_meta(meta):
            raise IssuanceError(400, "bad_meta")
        now = self._now()
        try:
            keys = await asyncio.to_thread(self._keys.current, now)
        except KeyUnavailableError:
            raise IssuanceError(503, "key_unavailable") from None
        encoded_length = 4 * ((keys.k_len + 2) // 3)
        messages = []
        for value in blinded:
            if not isinstance(value, str) or len(value) != encoded_length:
                raise IssuanceError(400, "bad_blinded")
            try:
                raw = base64.b64decode(value, validate=True)
            except (ValueError, binascii.Error):
                raise IssuanceError(400, "bad_blinded") from None
            if len(raw) != keys.k_len or base64.b64encode(raw).decode() != value:
                raise IssuanceError(400, "bad_blinded")
            messages.append(raw)
        # A stale value costs nothing: the client refetches /meta and retries. This
        # precedes the range check, which depends on the value's key, so any mismatch
        # is a 409.
        if meta != await self._meta_of(client):
            raise IssuanceError(409, "meta_mismatch")
        key = keys.keys[meta]
        if not all(0 < int.from_bytes(raw, "big") < key.key.n for raw in messages):
            raise IssuanceError(400, "bad_blinded")
        reservation = self._quota.take(client, len(messages), now)
        allowed = await reservation if inspect.isawaitable(reservation) else reservation
        if not allowed:
            raise IssuanceError(429, "quota_exceeded")
        # BlindSign every message with the key for this value. Nothing outlives the request.
        signatures = await asyncio.to_thread(_sign_batch, key.key, messages)
        # Failed signing/audit leaves quota reserved; retries cannot exceed the cap.
        event: AuditEvent = {
            "ts": now.isoformat(),
            "event": "issue",
            "client": client,
            "count": len(signatures),
            "epoch": keys.epoch,
        }
        if self._on_issue is None:
            print(json.dumps(event), flush=True)
        else:
            audit = self._on_issue(event)
            if inspect.isawaitable(audit):
                await audit
        return {"kid": key.kid, "signatures": signatures}
