"""Load each UTC month's four RSABSSA keys, and generate them ahead of time."""

import base64
import hashlib
import json
import os
import re
import tempfile
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from Crypto.PublicKey import RSA
from .rsabssa import META_VALUES, SUITE, SigningKey

ALG = SUITE
MODULUS_BITS = 2048
PUBLIC_EXPONENT = 65537
# Distinct file names: keys from other schemes or versions are never loaded.
KEY_FILE_SUFFIX = ".rsabssa.key.pem"
JWKS_FILE_SUFFIX = ".rsabssa.jwks.json"


def epoch_id(when: datetime) -> str:
    return when.astimezone(timezone.utc).strftime("ep-%Y-%m")


def previous_epoch_id(when: datetime) -> str:
    when = when.astimezone(timezone.utc)
    year, month = (when.year, when.month - 1) if when.month > 1 else (when.year - 1, 12)
    return f"ep-{year:04d}-{month:02d}"


def next_epoch_id(when: datetime) -> str:
    when = when.astimezone(timezone.utc)
    year, month = (when.year, when.month + 1) if when.month < 12 else (when.year + 1, 1)
    return f"ep-{year:04d}-{month:02d}"


def is_valid_epoch(epoch: str) -> bool:
    return re.fullmatch(r"ep-\d{4}-(0[1-9]|1[0-2])", epoch) is not None


def key_id(epoch: str, meta: int) -> str:
    """The key ID of an epoch's key for one metadata value: "ep-YYYY-MM.N"."""
    if not is_valid_epoch(epoch) or meta not in META_VALUES:
        raise ValueError("invalid epoch key id")
    return f"{epoch}.{meta}"


def b64u(value: int) -> str:
    return (
        base64.urlsafe_b64encode(value.to_bytes((value.bit_length() + 7) // 8, "big"))
        .rstrip(b"=")
        .decode()
    )


class KeyUnavailableError(Exception):
    """The current epoch has no keys on disk. Generate them ahead with the keygen command."""

    def __init__(self, epoch: str):
        super().__init__(
            f"no {epoch} keys; generate them with the keygen command before serving"
        )
        self.epoch = epoch


@dataclass(frozen=True)
class EpochSigningKey:
    kid: str
    meta: int
    key: SigningKey
    jwk: dict[str, str]


@dataclass(frozen=True)
class EpochKeySet:
    """One epoch's four keys; `keys[n]` signs tokens whose metadata value is n."""

    epoch: str
    k_len: int
    keys: tuple[EpochSigningKey, ...]


def epoch_key_path(directory: str | Path, epoch: str, meta: int) -> Path:
    return Path(directory) / f"{key_id(epoch, meta)}{KEY_FILE_SUFFIX}"


def epoch_jwks_path(directory: str | Path, epoch: str) -> Path:
    """The public JWKS fragment that the keygen command writes for each epoch."""
    if not is_valid_epoch(epoch):
        raise ValueError("invalid epoch id")
    return Path(directory) / f"{epoch}{JWKS_FILE_SUFFIX}"


def _load_key(directory: str | Path, epoch: str, meta: int) -> EpochSigningKey | None:
    try:
        raw = epoch_key_path(directory, epoch, meta).read_bytes()
    except FileNotFoundError:
        return None
    # Corrupt or unreadable keys raise: they are never silently replaced.
    rsa_key = RSA.import_key(raw)
    if (
        not rsa_key.has_private()
        or rsa_key.size_in_bits() != MODULUS_BITS
        or int(rsa_key.e) != PUBLIC_EXPONENT
    ):
        raise ValueError(f"expected an RSA-{MODULUS_BITS} key with e = 65537")
    key = SigningKey.from_rsa(rsa_key)
    kid = key_id(epoch, meta)
    return EpochSigningKey(
        kid=kid,
        meta=meta,
        key=key,
        jwk={
            "kty": "RSA",
            "n": b64u(key.n),
            "e": b64u(key.e),
            "kid": kid,
            "use": "sig",
            "alg": ALG,
        },
    )


def load_epoch_keys(directory: str | Path, epoch: str) -> EpochKeySet | None:
    """Load an epoch's four keys. None when none exists.

    An incomplete set, a key reused for two values or any invalid key raises, so the
    issuer fails closed instead of serving part of an epoch.
    """
    loaded = [_load_key(directory, epoch, meta) for meta in META_VALUES]
    keys = tuple(key for key in loaded if key is not None)
    if not keys:
        return None
    if len(keys) != len(META_VALUES):
        raise ValueError(f"incomplete {epoch} key set: {len(keys)} of 4 keys")
    if len({key.key.n for key in keys}) != len(keys):
        raise ValueError(f"{epoch} reuses a key for two metadata values")
    return EpochKeySet(epoch=epoch, k_len=MODULUS_BITS // 8, keys=keys)


class EpochKeys:
    """Loads persisted epoch keys. It never generates one: see generate_epoch_keys."""

    def __init__(self, directory: str | Path):
        self.directory = Path(directory)
        self._cache: dict[str, EpochKeySet] = {}
        self._lock = threading.Lock()

    def get(self, epoch: str) -> EpochKeySet | None:
        """A loaded key set, or None when the epoch has no keys (not cached)."""
        with self._lock:
            if epoch in self._cache:
                return self._cache[epoch]
            keys = load_epoch_keys(self.directory, epoch)
            if keys is not None:
                self._cache[epoch] = keys
            return keys

    def current(self, when: datetime) -> EpochKeySet:
        epoch = epoch_id(when)
        keys = self.get(epoch)
        if keys is None:
            raise KeyUnavailableError(epoch)
        return keys

    def publish(self, when: datetime) -> dict[str, list[dict[str, str]]]:
        """The current and previous months' keys that exist, four each; the same for all."""
        published = []
        for epoch in (epoch_id(when), previous_epoch_id(when)):
            keys = self.get(epoch)
            for key in keys.keys if keys is not None else ():
                published.append(dict(key.jwk))
        return {"keys": published}


def write_epoch_key(
    directory: str | Path, epoch: str, meta: int, key: RSA.RsaKey
) -> bool:
    """Persist one key as mode-0600 PKCS#8 with an atomic no-replace hard link.

    Returns False, leaving the file untouched, if a key already holds that epoch and value.
    """
    pem = key.export_key(format="PEM", pkcs=8)
    path = epoch_key_path(directory, epoch, meta)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{key_id(epoch, meta)}-", dir=path.parent)
    created = True
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(pem)
            output.flush()
            os.fsync(output.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            created = False
    finally:
        os.unlink(temporary)
    # Re-read the published file through the same checks the issuer applies.
    if _load_key(directory, epoch, meta) is None:
        raise RuntimeError("epoch key publication failed")
    return created


@dataclass(frozen=True)
class GeneratedKeys:
    epoch: str
    # Key IDs written by this call; existing keys are kept and not listed.
    created: list[str]
    # The public JWKS fragment, for publishing or auditing outside the issuer.
    jwks_path: Path
    # SHA-256 of each public modulus by key ID, for comparing replicas. Public information.
    modulus_sha256: dict[str, str]


def generate_epoch_keys(directory: str | Path, epoch: str) -> GeneratedKeys:
    """Generate any of an epoch's four RSA-2048 keys (e = 65537) that do not exist yet.

    Then write the epoch's public JWKS fragment. Uses PyCryptodome's RSA key generation,
    typically well under a second per key. Existing keys are never replaced.
    """
    created = []
    for meta in META_VALUES:
        if _load_key(directory, epoch, meta) is None:
            key = RSA.generate(MODULUS_BITS, e=PUBLIC_EXPONENT)
            if write_epoch_key(directory, epoch, meta, key):
                created.append(key_id(epoch, meta))
    keys = load_epoch_keys(directory, epoch)
    if keys is None:
        raise RuntimeError("epoch key publication failed")
    # The public halves, read from the key files; rewriting them is idempotent.
    jwks_path = epoch_jwks_path(directory, epoch)
    fd, temporary = tempfile.mkstemp(prefix=f".{epoch}-jwks-", dir=jwks_path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            output.write(
                json.dumps({"keys": [key.jwk for key in keys.keys]}, indent=2) + "\n"
            )
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, jwks_path)
    except BaseException:
        os.unlink(temporary)
        raise
    return GeneratedKeys(
        epoch=epoch,
        created=created,
        jwks_path=jwks_path,
        modulus_sha256={
            key.kid: hashlib.sha256(key.key.n.to_bytes(keys.k_len, "big")).hexdigest()
            for key in keys.keys
        },
    )
