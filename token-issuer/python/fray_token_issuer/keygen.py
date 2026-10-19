"""Key-generation command: python -m fray_token_issuer.keygen --keys-dir DIR [--epoch ...].

Generates each epoch's four RSABSSA keys ahead of time, writing the private key files and
the epoch's public JWKS fragment; the issuer itself never generates keys while serving.
"""

import os
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timezone
from .keys import epoch_id, generate_epoch_keys, is_valid_epoch, next_epoch_id

USAGE = "usage: fray-token-issuer-keygen --keys-dir DIR [--epoch current|next|ep-YYYY-MM]..."


def parse_args(
    argv: Sequence[str],
    env: Mapping[str, str] | None = None,
    now: datetime | None = None,
) -> tuple[str, list[str]]:
    """Parse `--keys-dir DIR` (or KEYS_DIR) and any number of `--epoch` values."""
    env = os.environ if env is None else env
    now = now or datetime.now(timezone.utc)
    keys_dir = env.get("KEYS_DIR")
    epochs: list[str] = []
    args = list(argv)
    while args:
        flag = args.pop(0)
        if flag not in ("--keys-dir", "--epoch") or not args:
            raise ValueError(USAGE)
        value = args.pop(0)
        if flag == "--keys-dir":
            keys_dir = value
        elif value == "current":
            epochs.append(epoch_id(now))
        elif value == "next":
            epochs.append(next_epoch_id(now))
        elif is_valid_epoch(value):
            epochs.append(value)
        else:
            raise ValueError(USAGE)
    if not keys_dir:
        raise ValueError(USAGE)
    return keys_dir, list(dict.fromkeys(epochs)) or [epoch_id(now)]


def main(
    argv: Sequence[str] | None = None, write: Callable[[str], object] = print
) -> int:
    """Generate each requested epoch's missing keys. Prints no key material."""
    try:
        keys_dir, epochs = parse_args(sys.argv[1:] if argv is None else argv)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2
    for epoch in epochs:
        started = time.monotonic()
        keys = generate_epoch_keys(keys_dir, epoch)
        status = (
            f"created {', '.join(keys.created)} in {time.monotonic() - started:.1f}s"
            if keys.created
            else "all four keys exist, kept"
        )
        write(f"{epoch}: {status}; public JWKS {keys.jwks_path}")
        for kid, digest in keys.modulus_sha256.items():
            write(f"  {kid} modulus SHA-256 {digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
