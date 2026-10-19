"""Cross-language interop: the TypeScript issuer (driven through its TEST ONLY stdio bridge)
signs, and this package's independent test-only client finalizes and verifies. Both issuers
must sign byte-identically. The TypeScript tests run the reverse direction with
@cloudflare/blindrsa-ts as the client."""

import asyncio
import base64
import json
import secrets
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fray_token_issuer import PrivacyTokenIssuer
from test_issuer import b64u_to_int, blind, finalize, verifies, write_test_epoch

TS_DIR = Path(__file__).resolve().parent.parent / "typescript"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(
    NODE is None or not (TS_DIR / "node_modules" / "tsx").exists(),
    reason="TypeScript package not installed (run npm ci in token-issuer/typescript)",
)


@pytest.fixture
def bridge():
    assert NODE is not None
    process = subprocess.Popen(
        [NODE, "--import", "tsx", "test/interop-bridge.ts"],
        cwd=TS_DIR,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    assert process.stdin is not None and process.stdout is not None

    def request(**payload):
        process.stdin.write(json.dumps(payload) + "\n")
        process.stdin.flush()
        line = process.stdout.readline()
        if not line:
            raise RuntimeError("TypeScript bridge exited")
        return json.loads(line)

    yield request
    process.stdin.close()
    process.wait(timeout=30)


def test_typescript_issued_signatures_finalize_and_verify_in_python(bridge, tmp_path):
    write_test_epoch(tmp_path, "ep-2026-01", 0)
    local = PrivacyTokenIssuer(
        keys_dir=tmp_path,
        validate_user=lambda subject: subject,
        meta_for=lambda subject: int(subject[-1]),
        clock=lambda: datetime(2026, 1, 5, 12, tzinfo=timezone.utc),
        on_issue=lambda _event: None,
    )
    jwks = bridge(method="GET", url="/.well-known/jwks.json")
    assert jwks["status"] == 200
    assert jwks["body"] == asyncio.run(local.publish_keys())
    keys = jwks["body"]["keys"]
    assert [key["kid"] for key in keys] == [f"ep-2026-01.{meta}" for meta in range(4)]
    n = [b64u_to_int(key["n"]) for key in keys]

    for meta in range(4):
        headers = {"authorization": f"Bearer interop-{meta}"}
        assert bridge(method="GET", url="/meta", headers=headers) == {
            "status": 200,
            "cacheControl": "no-store",
            "body": {"meta": meta},
        }
        tokens = []
        for _ in range(3):
            message = secrets.token_bytes(32)
            blinded, r_inv = blind(n[meta], message)
            tokens.append((message, blinded, r_inv))
        body = {
            "meta": meta,
            "blinded": [base64.b64encode(t[1]).decode() for t in tokens],
        }

        mismatch = bridge(
            method="POST",
            url="/issue",
            headers=headers,
            body={**body, "meta": (meta + 1) % 4},
        )
        assert (mismatch["status"], mismatch["body"]) == (
            409,
            {"error": "meta_mismatch"},
        )

        issued = bridge(method="POST", url="/issue", headers=headers, body=body)
        assert issued["status"] == 200
        assert issued["body"]["kid"] == f"ep-2026-01.{meta}"
        # Deterministic RSASP1: the TypeScript and Python issuers agree byte for byte.
        assert issued["body"] == asyncio.run(local.issue(f"account-{meta}", body))
        for (message, _, r_inv), signature in zip(tokens, issued["body"]["signatures"]):
            sig = finalize(n[meta], message, base64.b64decode(signature), r_inv)
            for other in range(4):
                if other != meta:
                    assert not verifies(n[other], message, sig)
