"""Persist one RSA key per UTC month; derive its public half from that key."""

import base64
import os
import re
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from Crypto.PublicKey import RSA

ALG = "RSABSSA-SHA384-PSS-Deterministic"


def epoch_id(when: datetime) -> str:
    return when.astimezone(timezone.utc).strftime("ep-%Y-%m")


def previous_epoch_id(when: datetime) -> str:
    when = when.astimezone(timezone.utc)
    year, month = (when.year, when.month - 1) if when.month > 1 else (when.year - 1, 12)
    return f"ep-{year:04d}-{month:02d}"


def b64u(value: int) -> str:
    return (
        base64.urlsafe_b64encode(value.to_bytes((value.bit_length() + 7) // 8, "big"))
        .rstrip(b"=")
        .decode()
    )


class EpochKeys:
    def __init__(self, directory: str | Path):
        self.directory = Path(directory)
        self._cache: dict[str, RSA.RsaKey] = {}
        self._lock = threading.Lock()

    def _path(self, kid: str) -> Path:
        if not re.fullmatch(r"ep-\d{4}-(0[1-9]|1[0-2])", kid):
            raise ValueError("invalid epoch key id")
        return self.directory / f"{kid}.key.pem"

    def _load(self, kid: str) -> RSA.RsaKey | None:
        try:
            raw = self._path(kid).read_bytes()
        except FileNotFoundError:
            return None
        key = RSA.import_key(raw)
        if not key.has_private() or key.size_in_bits() < 2048:
            raise ValueError("expected RSA private key of at least 2048 bits")
        return key

    def get(self, kid: str, *, create: bool = False) -> RSA.RsaKey | None:
        with self._lock:
            if kid in self._cache:
                return self._cache[kid]
            key = self._load(kid)
            if key is None and create:
                self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
                generated = RSA.generate(2048, e=65537)
                fd, temporary = tempfile.mkstemp(prefix=f".{kid}-", dir=self.directory)
                try:
                    with os.fdopen(fd, "wb") as output:
                        output.write(generated.export_key(format="PEM", pkcs=8))
                        output.flush()
                        os.fsync(output.fileno())
                    # Atomic, no-replace publication: racing writers load the winner.
                    try:
                        os.link(temporary, self._path(kid))
                    except FileExistsError:
                        pass
                finally:
                    os.unlink(temporary)
                key = self._load(kid)
                if key is None:
                    raise RuntimeError("epoch key publication failed")
            if key is not None:
                self._cache[kid] = key
            return key

    def current(self, when: datetime) -> tuple[str, RSA.RsaKey]:
        kid = epoch_id(when)
        key = self.get(kid, create=True)
        assert key is not None
        return kid, key

    def publish(self, when: datetime) -> dict[str, list[dict[str, str]]]:
        current, _ = self.current(when)
        keys = []
        for kid in (current, previous_epoch_id(when)):
            key = self.get(kid)
            if key is not None:
                keys.append(
                    {
                        "kty": "RSA",
                        "n": b64u(key.n),
                        "e": b64u(key.e),
                        "kid": kid,
                        "use": "sig",
                        "alg": ALG,
                    }
                )
        return {"keys": keys}
