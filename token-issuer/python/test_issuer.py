import asyncio
import base64
import hashlib
import math
import secrets
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from fastapi.testclient import TestClient
from fray_token_issuer import DailyQuota, IssuanceError, PrivacyTokenIssuer, create_app
from fray_token_issuer.keys import EpochKeys
from app import create_demo_app

AUTH = {"Authorization": "Bearer test-session"}


@pytest.fixture
def setup(tmp_path):
    def make(limit=8):
        now = [datetime(2026, 1, 5, 12, tzinfo=timezone.utc)]
        events = []

        async def validate_user(request):
            auth = request.headers.get("authorization")
            if auth == "Bearer test-session":
                return "user-a"
            if auth == "Bearer other-session":
                return "user-b"
            return None

        issuer = PrivacyTokenIssuer(
            keys_dir=tmp_path,
            validate_user=validate_user,
            quota=DailyQuota(limit),
            clock=lambda: now[0],
            on_issue=events.append,
        )
        return issuer, TestClient(create_app(issuer)), now, events

    return make


HLEN = 48  # SHA-384
SLEN = 48  # protocol.md §2: salt length 48


# ---- test-only RSABSSA client (RFC 9474 §4.1/§4.3 over RFC 8017 EMSA-PSS) ----


def mgf1_sha384(seed: bytes, mask_len: int) -> bytes:
    out = b""
    for counter in range(math.ceil(mask_len / HLEN)):
        out += hashlib.sha384(seed + counter.to_bytes(4, "big")).digest()
    return out[:mask_len]


def emsa_pss_encode(msg: bytes, em_bits: int) -> bytes:
    """RFC 8017 §9.1.1 with Hash=MGF-Hash=SHA-384, sLen=48."""
    m_hash = hashlib.sha384(msg).digest()
    em_len = math.ceil(em_bits / 8)
    salt = secrets.token_bytes(SLEN)
    h = hashlib.sha384(b"\x00" * 8 + m_hash + salt).digest()
    ps = b"\x00" * (em_len - SLEN - HLEN - 2)
    db = ps + b"\x01" + salt
    db_mask = mgf1_sha384(h, em_len - HLEN - 1)
    masked_db = bytes(a ^ b for a, b in zip(db, db_mask))
    # Zero the leftmost 8*emLen - emBits bits of the first octet.
    top_zero_bits = 8 * em_len - em_bits
    masked_db = bytes([masked_db[0] & (0xFF >> top_zero_bits)]) + masked_db[1:]
    return masked_db + h + b"\xbc"


def blind(n: int, e: int, msg: bytes):
    k_len = (n.bit_length() + 7) // 8
    m = int.from_bytes(emsa_pss_encode(msg, n.bit_length() - 1), "big")
    assert math.gcd(m, n) == 1
    while True:
        r = secrets.randbelow(n - 1) + 1
        if math.gcd(r, n) == 1:
            break
    r_inv = pow(r, -1, n)
    z = (m * pow(r, e, n)) % n
    return z.to_bytes(k_len, "big"), r_inv


def finalize(n: int, e: int, msg: bytes, blind_sig: bytes, r_inv: int) -> bytes:
    k_len = (n.bit_length() + 7) // 8
    s = (int.from_bytes(blind_sig, "big") * r_inv) % n
    sig = s.to_bytes(k_len, "big")
    # Verify with a standard RSA-PSS verifier — the whole point of RSABSSA is
    # that finalized signatures are plain RSA-PSS signatures.
    pub = rsa.RSAPublicNumbers(e, n).public_key()
    pub.verify(
        sig,
        msg,
        padding.PSS(mgf=padding.MGF1(hashes.SHA384()), salt_length=SLEN),
        hashes.SHA384(),
    )
    return sig


def b64u_to_int(value: str) -> int:
    return int.from_bytes(
        base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)), "big"
    )


def current_key(client):
    response = client.get("/.well-known/jwks.json")
    assert response.status_code == 200
    jwk = response.json()["keys"][0]
    assert jwk["use"] == "sig"
    assert jwk["alg"] == "RSABSSA-SHA384-PSS-Deterministic"
    return b64u_to_int(jwk["n"]), b64u_to_int(jwk["e"])


def make_batch(n, e, count):
    tokens = []
    for _ in range(count):
        message = secrets.token_bytes(32)
        blinded, inverse = blind(n, e, message)
        tokens.append((message, inverse, base64.b64encode(blinded).decode()))
    return tokens


def test_issue_finalize_verify(setup):
    _, client, _, events = setup()
    with client:
        n, e = current_key(client)
        tokens = make_batch(n, e, 3)
        result = client.post(
            "/issue", json={"blinded": [token[2] for token in tokens]}, headers=AUTH
        )
        assert result.status_code == 200
        assert result.headers["cache-control"] == "no-store"
        assert result.json()["kid"] == "ep-2026-01"
        signatures = result.json()["signatures"]
        assert len(signatures) == 3
        for (message, inverse, _), signature in zip(tokens, signatures):
            sig = finalize(n, e, message, base64.b64decode(signature), inverse)
            assert len(sig) == 256
        assert events == [
            {
                "ts": "2026-01-05T12:00:00+00:00",
                "event": "issue",
                "client": "user-a",
                "count": 3,
                "epoch": "ep-2026-01",
            }
        ]


def test_auth_rejection(setup):
    _, client, _, events = setup()
    with client:
        for auth in (None, "Bearer wrong", "Basic invalid"):
            result = client.post(
                "/issue",
                json={"blinded": ["AAAA"]},
                headers={} if auth is None else {"Authorization": auth},
            )
            assert result.status_code == 401
            assert result.json() == {"error": "unauthorized"}
        assert events == []


def test_batch_validation_does_not_consume_quota(setup):
    _, client, _, _ = setup(3)
    with client:
        n, e = current_key(client)
        batch = [token[2] for token in make_batch(n, e, 3)]
        noncanonical = base64.b64encode((1).to_bytes(256, "big")).decode()[:-3] + "R=="
        cases = [
            None,
            {},
            {"blinded": []},
            {"blinded": [batch[0]] * 65},
            {"blinded": [None]},
            {"blinded": ["!!not base64!!"]},
            {"blinded": ["AAAA"]},
            {"blinded": [base64.b64encode(bytes(256)).decode()]},
            {"blinded": [base64.b64encode(n.to_bytes(256, "big")).decode()]},
            {"blinded": [noncanonical]},
            {"blinded": [batch[0], "bad"]},
        ]
        for body in cases:
            result = client.post("/issue", json=body, headers=AUTH)
            assert result.status_code == 400
        assert (
            client.post("/issue", json={"blinded": batch}, headers=AUTH).status_code
            == 200
        )
        assert (
            client.post("/issue", json={"blinded": batch[:1]}, headers=AUTH).status_code
            == 429
        )


def test_atomic_per_user_quota_and_utc_rollover(setup):
    _, client, now, _ = setup(3)
    with client:
        n, e = current_key(client)
        token = make_batch(n, e, 1)[0][2]

        def post(count):
            return client.post(
                "/issue", json={"blinded": [token] * count}, headers=AUTH
            ).status_code

        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(post, [2] * 4))
        assert results.count(200) == 1
        assert results.count(429) == 3
        assert post(1) == 200
        assert post(1) == 429
        assert (
            client.post(
                "/issue",
                json={"blinded": [token]},
                headers={"Authorization": "Bearer other-session"},
            ).status_code
            == 200
        )
        now[0] = datetime(2026, 1, 6, tzinfo=timezone.utc)
        assert post(1) == 200


def test_key_rotation_persistence_and_year_boundary(tmp_path):
    keys = EpochKeys(tmp_path)
    keys.publish(datetime(2025, 11, 30, tzinfo=timezone.utc))
    keys.publish(datetime(2025, 12, 31, tzinfo=timezone.utc))
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    published = keys.publish(now)
    assert [key["kid"] for key in published["keys"]] == ["ep-2026-01", "ep-2025-12"]
    assert EpochKeys(tmp_path).publish(now) == published
    assert (tmp_path / "ep-2026-01.key.pem").stat().st_mode & 0o777 == 0o600


def test_independent_key_managers_converge(tmp_path):
    def publish(_):
        return EpochKeys(tmp_path).publish(datetime(2026, 1, 1, tzinfo=timezone.utc))

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(publish, range(4)))
    assert all(result == results[0] for result in results)


def test_corrupt_key_fails_closed(tmp_path):
    path = tmp_path / "ep-2026-01.key.pem"
    path.write_text("corrupt key")
    with pytest.raises(ValueError):
        EpochKeys(tmp_path).publish(datetime(2026, 1, 1, tzinfo=timezone.utc))
    assert path.read_text() == "corrupt key"


def test_http_errors_do_not_echo_input(setup):
    _, client, _, _ = setup()
    with client:
        result = client.post("/issue", content=b"{bad-secret", headers=AUTH)
        assert result.status_code == 400
        assert "secret" not in result.text
        result = client.post("/issue", json={"blinded": ["x" * 70000]}, headers=AUTH)
        assert result.status_code == 413


def test_custom_auth_and_quota_can_be_async(tmp_path):
    subjects = []

    async def validate_user(context):
        return "stable-subject" if context == "valid-session" else None

    class Store:
        async def take(self, client, count, when):
            subjects.append((client, count))
            return False

    issuer = PrivacyTokenIssuer(
        keys_dir=tmp_path, validate_user=validate_user, quota=Store()
    )

    async def exercise():
        with pytest.raises(IssuanceError) as rejected:
            await issuer.issue("wrong", {"blinded": ["AAAA"]})
        assert rejected.value.status == 401
        jwk = (await issuer.publish_keys())["keys"][0]
        token = make_batch(b64u_to_int(jwk["n"]), b64u_to_int(jwk["e"]), 1)[0][2]
        with pytest.raises(IssuanceError) as limited:
            await issuer.issue("valid-session", {"blinded": [token]})
        assert limited.value.status == 429

    asyncio.run(exercise())
    assert subjects == [("stable-subject", 1)]


def test_demo_auth_requires_explicit_opt_in(monkeypatch):
    monkeypatch.delenv("FRAY_LOCAL_DEMO", raising=False)
    monkeypatch.delenv("LOCAL_DEMO_TOKEN", raising=False)
    with pytest.raises(RuntimeError):
        create_demo_app()
    monkeypatch.setenv("FRAY_LOCAL_DEMO", "1")
    monkeypatch.setenv("LOCAL_DEMO_TOKEN", "local-example-token")
    monkeypatch.setenv("FRAY_ENV", "production")
    with pytest.raises(RuntimeError):
        create_demo_app()
    for quota in (0, -1, 65, True, 1.5):
        with pytest.raises(ValueError):
            DailyQuota(quota)


def test_out_of_order_midnight_requests_cannot_reset_allowances():
    quota = DailyQuota(2)
    before = datetime(2026, 1, 1, 23, 59, 59, tzinfo=timezone.utc)
    after = datetime(2026, 1, 2, tzinfo=timezone.utc)
    assert quota.take("user", 2, before)
    assert quota.take("user", 2, after)
    assert not quota.take("user", 1, before)
    assert not quota.take("user", 1, after)


def test_auth_hook_failure_is_not_returned_or_reraised_to_server(tmp_path):
    async def validate_user(_request):
        raise RuntimeError("private authentication diagnostic")

    issuer = PrivacyTokenIssuer(keys_dir=tmp_path, validate_user=validate_user)
    with TestClient(create_app(issuer)) as client:
        response = client.post("/issue", json={"blinded": ["AAAA"]})
        assert response.status_code == 500
        assert response.json() == {"error": "internal_error"}
