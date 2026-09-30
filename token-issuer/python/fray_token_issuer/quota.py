"""The default quota is process-local. Inject a durable atomic store in production."""

import threading
from collections.abc import Awaitable
from datetime import date, datetime, timedelta, timezone
from typing import Protocol


class QuotaStore(Protocol):
    def take(self, client: str, count: int, when: datetime) -> bool | Awaitable[bool]:
        """Reserve the whole batch atomically, or return False without changing usage."""
        ...


class DailyQuota:
    def __init__(self, limit: int = 64):
        if type(limit) is not int or not 1 <= limit <= 64:
            raise ValueError("quota must be an integer from 1 to 64")
        self.limit = limit
        self._used: dict[tuple[date, str], int] = {}
        self._latest_day: date | None = None
        self._lock = threading.Lock()

    def take(self, client: str, count: int, when: datetime) -> bool:
        if type(count) is not int or count < 1:
            raise ValueError("count must be a positive integer")
        day = when.astimezone(timezone.utc).date()
        with self._lock:
            if self._latest_day is None or day > self._latest_day:
                self._latest_day = day
                self._used = {
                    key: count
                    for key, count in self._used.items()
                    if key[0] >= day - timedelta(days=1)
                }
            # An in-flight request from yesterday must not reset today's counter.
            if day < self._latest_day - timedelta(days=1):
                return False
            key = (day, client)
            used = self._used.get(key, 0)
            if used + count > self.limit:
                return False
            self._used[key] = used + count
            return True
