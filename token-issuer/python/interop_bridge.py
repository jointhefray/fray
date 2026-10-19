"""TEST ONLY: a stdio bridge for the TypeScript interop test (../typescript/test/interop.test.ts).

Serves this package's issuer, with the committed TEST ONLY fixture keys, through FastAPI's
TestClient: one JSON request per input line, one JSON response per output line. No network.
"Bearer interop-<m>" authenticates a test account whose metadata value is m.
"""

import json
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from Crypto.PublicKey import RSA  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from fray_token_issuer import PrivacyTokenIssuer, create_app  # noqa: E402
from fray_token_issuer.keys import write_epoch_key  # noqa: E402


def main() -> None:
    fixture = HERE.parent / "test-fixtures" / "test-only-rsabssa-keys.json"
    keys = [k for k in json.loads(fixture.read_text())["keys"] if k["set"] == 0]
    with tempfile.TemporaryDirectory(prefix="fray-interop-") as directory:
        for key in keys:
            p, q = int(key["p"], 16), int(key["q"], 16)
            d = pow(65537, -1, (p - 1) * (q - 1))
            rsa_key = RSA.construct((p * q, 65537, d, p, q))
            write_epoch_key(directory, "ep-2026-01", key["meta"], rsa_key)

        def validate_user(request):
            match = re.fullmatch(
                r"Bearer interop-([0-3])", request.headers.get("authorization", "")
            )
            return f"account-{match.group(1)}" if match else None

        issuer = PrivacyTokenIssuer(
            keys_dir=directory,
            validate_user=validate_user,
            meta_for=lambda subject: int(subject[-1]),
            clock=lambda: datetime(2026, 1, 5, 12, tzinfo=timezone.utc),
            on_issue=lambda _event: None,
        )
        with TestClient(create_app(issuer)) as client:
            for line in sys.stdin:
                request = json.loads(line)
                response = client.request(
                    request["method"],
                    request["url"],
                    headers=request.get("headers") or {},
                    **({"json": request["body"]} if "body" in request else {}),
                )
                print(
                    json.dumps(
                        {
                            "status": response.status_code,
                            "cacheControl": response.headers.get("cache-control"),
                            "body": response.json(),
                        }
                    ),
                    flush=True,
                )


if __name__ == "__main__":
    main()
