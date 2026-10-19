import asyncio
import base64
import dataclasses
import hashlib
import json
import math
import secrets
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import pytest
from Crypto.PublicKey import RSA
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from fastapi.testclient import TestClient
from fray_token_issuer import (
    DailyQuota,
    IssuanceError,
    KeyUnavailableError,
    PrivacyTokenIssuer,
    create_app,
    epoch_id,
    generate_epoch_keys,
    is_token_meta,
)
from fray_token_issuer.keygen import parse_args
from fray_token_issuer.keys import (
    EpochKeys,
    epoch_jwks_path,
    epoch_key_path,
    write_epoch_key,
)
from fray_token_issuer.rsabssa import SigningKey, blind_sign
from app import create_demo_app

ALG = "RSABSSA-SHA384-PSS-Deterministic"
AUTH = {"Authorization": "Bearer test-session"}
OTHER = {"Authorization": "Bearer other-session"}
FIXTURES = Path(__file__).resolve().parent.parent / "test-fixtures"

# TEST ONLY fixtures: two sets (two epochs) of four RSA-2048 keys, indexed [set][meta].
_KEYS = json.loads((FIXTURES / "test-only-rsabssa-keys.json").read_text())["keys"]
TEST_KEYS = [
    [
        next(
            (int(k["p"], 16), int(k["q"], 16))
            for k in _KEYS
            if (k["set"], k["meta"]) == (s, m)
        )
        for m in range(4)
    ]
    for s in range(2)
]
RFC_VECTOR = json.loads((FIXTURES / "rfc9474-a3-test-vector.json").read_text())[
    "vector"
]


def rsa_key(p: int, q: int) -> RSA.RsaKey:
    return RSA.construct((p * q, 65537, pow(65537, -1, (p - 1) * (q - 1)), p, q))


def fixture_key(set_index: int, meta: int) -> RSA.RsaKey:
    return rsa_key(*TEST_KEYS[set_index][meta])


def write_test_epoch(directory, epoch, set_index=0, metas=(0, 1, 2, 3)):
    for meta in metas:
        write_epoch_key(directory, epoch, meta, fixture_key(set_index, meta))


# ---- test-only RSABSSA client (RFC 9474 Blind/Finalize over RFC 8017 EMSA-PSS) ----
# Independent of the issuer: PSS verification comes from `cryptography`.

HLEN = 48  # SHA-384
SLEN = 48  # PSS salt length


def mgf1_sha384(seed: bytes, mask_len: int) -> bytes:
    out = b""
    for counter in range(math.ceil(mask_len / HLEN)):
        out += hashlib.sha384(seed + counter.to_bytes(4, "big")).digest()
    return out[:mask_len]


def emsa_pss_encode(msg: bytes, em_bits: int, salt: bytes) -> bytes:
    """RFC 8017 section 9.1.1 with Hash = MGF-Hash = SHA-384, sLen = 48."""
    m_hash = hashlib.sha384(msg).digest()
    em_len = math.ceil(em_bits / 8)
    h = hashlib.sha384(b"\x00" * 8 + m_hash + salt).digest()
    db = b"\x00" * (em_len - SLEN - HLEN - 2) + b"\x01" + salt
    masked_db = bytes(a ^ b for a, b in zip(db, mgf1_sha384(h, em_len - HLEN - 1)))
    top_zero_bits = 8 * em_len - em_bits
    masked_db = bytes([masked_db[0] & (0xFF >> top_zero_bits)]) + masked_db[1:]
    return masked_db + h + b"\xbc"


def blind(n: int, msg: bytes, r: int | None = None, salt: bytes | None = None):
    k_len = (n.bit_length() + 7) // 8
    encoded = emsa_pss_encode(
        msg, n.bit_length() - 1, salt or secrets.token_bytes(SLEN)
    )
    m = int.from_bytes(encoded, "big")
    assert math.gcd(m, n) == 1
    while r is None or math.gcd(r, n) != 1:
        r = secrets.randbelow(n - 1) + 1
    z = (m * pow(r, 65537, n)) % n
    return z.to_bytes(k_len, "big"), pow(r, -1, n)


def verifies(n: int, msg: bytes, sig: bytes) -> bool:
    public = rsa.RSAPublicNumbers(65537, n).public_key()
    try:
        public.verify(
            sig,
            msg,
            padding.PSS(mgf=padding.MGF1(hashes.SHA384()), salt_length=SLEN),
            hashes.SHA384(),
        )
    except InvalidSignature:
        return False
    return True


def finalize(n: int, msg: bytes, blind_sig: bytes, r_inv: int) -> bytes:
    k_len = (n.bit_length() + 7) // 8
    assert len(blind_sig) == k_len
    sig = ((int.from_bytes(blind_sig, "big") * r_inv) % n).to_bytes(k_len, "big")
    assert verifies(n, msg, sig), "invalid signature"
    return sig


def b64u_to_int(value: str) -> int:
    return int.from_bytes(
        base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)), "big"
    )


def make_batch(n, count):
    tokens = []
    for _ in range(count):
        message = secrets.token_bytes(32)
        blinded, inverse = blind(n, message)
        tokens.append((message, inverse, base64.b64encode(blinded).decode()))
    return tokens


# ---- issuer fixture ----


@pytest.fixture
def setup(tmp_path):
    def make(limit=8):
        write_test_epoch(tmp_path, "ep-2026-01", 0)
        now = [datetime(2026, 1, 5, 12, tzinfo=timezone.utc)]
        events = []
        meta_calls = []
        validate_calls = []
        account_meta = {"user-a": 2, "user-b": 0}

        async def validate_user(request):
            validate_calls.append(1)
            auth = request.headers.get("authorization")
            if auth == "Bearer test-session":
                return "user-a"
            if auth == "Bearer other-session":
                return "user-b"
            return None

        async def meta_for(subject):
            meta_calls.append(subject)
            return account_meta[subject]

        issuer = PrivacyTokenIssuer(
            keys_dir=tmp_path,
            validate_user=validate_user,
            meta_for=meta_for,
            **({} if limit is None else {"quota": DailyQuota(limit)}),
            clock=lambda: now[0],
            on_issue=events.append,
        )
        return {
            "issuer": issuer,
            "client": TestClient(create_app(issuer)),
            "now": now,
            "events": events,
            "meta_calls": meta_calls,
            "validate_calls": validate_calls,
            "account_meta": account_meta,
            "dir": tmp_path,
        }

    return make


def moduli(client):
    """The current epoch's four moduli, by metadata value, from the published JWKS."""
    response = client.get("/.well-known/jwks.json")
    assert response.status_code == 200
    return [b64u_to_int(key["n"]) for key in response.json()["keys"][:4]]


def test_rfc9474_a3_vector_issuer_and_test_client():
    p, q, n = (int(RFC_VECTOR[name], 16) for name in ("p", "q", "n"))
    assert p * q == n
    msg = bytes.fromhex(RFC_VECTOR["msg"])
    r = pow(int(RFC_VECTOR["inv"], 16), -1, n)
    blinded, r_inv = blind(n, msg, r=r, salt=bytes.fromhex(RFC_VECTOR["salt"]))
    assert blinded.hex() == RFC_VECTOR["blinded_msg"]
    blind_sig = blind_sign(SigningKey.from_rsa(rsa_key(p, q)), blinded)
    assert blind_sig.hex() == RFC_VECTOR["blind_sig"]
    assert finalize(n, msg, blind_sig, r_inv).hex() == RFC_VECTOR["sig"]


def test_fault_protection_explicit_check_rejects_a_faulty_crt_half():
    for meta in range(4):
        key = SigningKey.from_rsa(fixture_key(0, meta))
        m = secrets.randbelow(key.n)
        blinded = m.to_bytes(256, "big")
        assert int.from_bytes(blind_sign(key, blinded), "big") == pow(m, key.d, key.n)
        for faulty in (
            dataclasses.replace(key, dp=key.dp ^ 2),
            dataclasses.replace(key, dq=key.dq ^ 2),
        ):
            # This signer computes CRT itself and nothing checks it internally: the
            # explicit RSAVP1 check must refuse rather than return a faulty signature.
            with pytest.raises(RuntimeError, match="signing failure"):
                blind_sign(faulty, blinded)


def test_client_flow_signs_with_the_key_for_the_accounts_meta(setup):
    s = setup()
    with s["client"] as client:
        n = moduli(client)
        response = client.get("/meta", headers=AUTH)
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert response.json() == {"meta": 2}
        tokens = make_batch(n[2], 3)
        result = client.post(
            "/issue", json={"meta": 2, "blinded": [t[2] for t in tokens]}, headers=AUTH
        )
        assert result.status_code == 200
        assert result.headers["cache-control"] == "no-store"
        assert result.json()["kid"] == "ep-2026-01.2"
        signatures = result.json()["signatures"]
        assert len(signatures) == 3
        for (message, inverse, _), signature in zip(tokens, signatures):
            sig = finalize(n[2], message, base64.b64decode(signature), inverse)
            assert len(sig) == 256
            assert not verifies(n[2], secrets.token_bytes(32), sig)
        assert s["events"] == [
            {
                "ts": "2026-01-05T12:00:00+00:00",
                "event": "issue",
                "client": "user-a",
                "count": 3,
                "epoch": "ep-2026-01",
            }
        ]


def test_token_signed_with_key_1_does_not_verify_as_meta_2(setup):
    s = setup()
    s["account_meta"]["user-a"] = 1
    with s["client"] as client:
        n = moduli(client)
        [(message, inverse, blinded)] = make_batch(n[1], 1)
        result = client.post(
            "/issue", json={"meta": 1, "blinded": [blinded]}, headers=AUTH
        )
        assert result.json()["kid"] == "ep-2026-01.1"
        blind_sig = base64.b64decode(result.json()["signatures"][0])
        sig = finalize(n[1], message, blind_sig, inverse)
        for other in (0, 2, 3):
            assert not verifies(n[other], message, sig)


def test_meta_endpoint_uses_host_auth_and_no_store(setup):
    s = setup()
    with s["client"] as client:
        for auth in (None, "Bearer wrong", "Basic invalid"):
            result = client.get(
                "/meta", headers={} if auth is None else {"Authorization": auth}
            )
            assert result.status_code == 401
            assert result.headers["cache-control"] == "no-store"
            assert result.json() == {"error": "unauthorized"}
        assert s["meta_calls"] == []
        assert client.get("/meta", headers=AUTH).json() == {"meta": 2}
        assert client.get("/meta", headers=OTHER).json() == {"meta": 0}
        assert s["meta_calls"] == ["user-a", "user-b"]


def test_meta_mismatch_is_409_and_consumes_no_quota(setup):
    s = setup(3)
    with s["client"] as client:
        n = moduli(client)
        for_two = [t[2] for t in make_batch(n[2], 3)]
        for meta in (0, 1, 3, 0, 1, 3):
            result = client.post(
                "/issue", json={"meta": meta, "blinded": for_two}, headers=AUTH
            )
            assert result.status_code == 409
            assert result.headers["cache-control"] == "no-store"
            assert result.json() == {"error": "meta_mismatch"}
        # Any mismatch is a 409, even for a batch outside the claimed key's modulus.
        largest = max(n)
        outside = base64.b64encode((largest - 1).to_bytes(256, "big")).decode()
        for meta in (m for m in (0, 1, 3) if n[m] < largest):
            result = client.post(
                "/issue", json={"meta": meta, "blinded": [outside]}, headers=AUTH
            )
            assert result.json() == {"error": "meta_mismatch"}
        assert s["events"] == []
        # The account's value changes between /meta and /issue: refetch and retry.
        s["account_meta"]["user-a"] = 3
        post = lambda meta, blinded: client.post(  # noqa: E731
            "/issue", json={"meta": meta, "blinded": blinded}, headers=AUTH
        ).status_code
        assert post(2, for_two) == 409
        assert client.get("/meta", headers=AUTH).json() == {"meta": 3}
        for_three = [t[2] for t in make_batch(n[3], 3)]
        assert post(3, for_three) == 200
        assert post(3, for_three[:1]) == 429
        assert len(s["events"]) == 1


def test_request_meta_must_be_0_to_3_before_any_quota(setup):
    s = setup(2)
    with s["client"] as client:
        blinded = [t[2] for t in make_batch(moduli(client)[2], 2)]
        bad_metas = (-1, 4, 1.5, 2.0, "2", None, True, [2], {})
        for body in (
            {"blinded": blinded},
            *({"meta": meta, "blinded": blinded} for meta in bad_metas),
        ):
            result = client.post("/issue", json=body, headers=AUTH)
            assert result.status_code == 400
            assert result.json() == {"error": "bad_meta"}
        assert s["meta_calls"] == []
        assert (
            client.post(
                "/issue", json={"meta": 2, "blinded": blinded}, headers=AUTH
            ).status_code
            == 200
        )


def test_meta_for_failures_fail_closed_without_quota(tmp_path):
    write_test_epoch(tmp_path, "ep-2026-01", 0)
    result = [lambda: 1]
    taken = []

    class Store:
        def take(self, client, count, when):
            taken.append(count)
            return True

    def fail():
        raise RuntimeError("private metadata diagnostic")

    issuer = PrivacyTokenIssuer(
        keys_dir=tmp_path,
        validate_user=lambda _request: "subject",
        meta_for=lambda _subject: result[0](),
        quota=Store(),
        clock=lambda: datetime(2026, 1, 5, 12, tzinfo=timezone.utc),
        on_issue=lambda _event: None,
    )
    with TestClient(create_app(issuer)) as client:
        blinded = [t[2] for t in make_batch(moduli(client)[1], 1)]
        for failure in (
            lambda: 4,
            lambda: -1,
            lambda: 1.5,
            lambda: "1",
            lambda: None,
            lambda: True,
            fail,
        ):
            result[0] = failure
            for response in (
                client.get("/meta"),
                client.post("/issue", json={"meta": 1, "blinded": blinded}),
            ):
                assert response.status_code == 500
                assert response.json() == {"error": "internal_error"}
                assert "diagnostic" not in response.text
        assert taken == []
        result[0] = lambda: 1
        assert (
            client.post("/issue", json={"meta": 1, "blinded": blinded}).status_code
            == 200
        )
        assert taken == [1]


def test_batch_validation_does_not_consume_quota(setup):
    s = setup(3)
    with s["client"] as client:
        n = moduli(client)
        batch = [t[2] for t in make_batch(n[2], 3)]
        noncanonical = base64.b64encode((1).to_bytes(256, "big")).decode()[:-3] + "R=="
        cases = [
            None,
            {},
            {"meta": 2},
            {"meta": 2, "blinded": []},
            {"meta": 2, "blinded": [batch[0]] * 17},
            {"meta": 2, "blinded": [None]},
            {"meta": 2, "blinded": ["!!not base64!!"]},
            {"meta": 2, "blinded": ["AAAA"]},
            {"meta": 2, "blinded": [base64.b64encode(bytes(256)).decode()]},
            {
                "meta": 2,
                "blinded": [base64.b64encode(n[2].to_bytes(256, "big")).decode()],
            },
            {"meta": 2, "blinded": [noncanonical]},
            {"meta": 2, "blinded": [batch[0], "bad"]},
        ]
        for body in cases:
            assert client.post("/issue", json=body, headers=AUTH).status_code == 400
        post = lambda blinded: client.post(  # noqa: E731
            "/issue", json={"meta": 2, "blinded": blinded}, headers=AUTH
        ).status_code
        assert post(batch) == 200
        assert post(batch[:1]) == 429


def test_default_quota_is_one_batch_of_16(setup):
    s = setup(None)
    with s["client"] as client:
        token = make_batch(moduli(client)[2], 1)[0][2]
        result = client.post(
            "/issue", json={"meta": 2, "blinded": [token] * 16}, headers=AUTH
        )
        assert result.status_code == 200
        assert len(result.json()["signatures"]) == 16
        assert (
            client.post(
                "/issue", json={"meta": 2, "blinded": [token]}, headers=AUTH
            ).status_code
            == 429
        )


def test_atomic_per_user_quota_and_utc_rollover(setup):
    s = setup(3)
    with s["client"] as client:
        n = moduli(client)
        for_two = make_batch(n[2], 1)[0][2]
        for_zero = make_batch(n[0], 1)[0][2]

        def post(count):
            return client.post(
                "/issue", json={"meta": 2, "blinded": [for_two] * count}, headers=AUTH
            ).status_code

        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(post, [2] * 4))
        assert results.count(200) == 1
        assert results.count(429) == 3
        assert post(1) == 200
        assert post(1) == 429
        assert (
            client.post(
                "/issue", json={"meta": 0, "blinded": [for_zero]}, headers=OTHER
            ).status_code
            == 200
        )
        s["now"][0] = datetime(2026, 1, 6, tzinfo=timezone.utc)
        assert post(1) == 200


def test_jwks_eight_keys_public_unauthenticated_and_identical(setup):
    s = setup()
    write_test_epoch(s["dir"], "ep-2025-12", 1)
    with s["client"] as client:
        before = len(s["validate_calls"])
        responses = [
            client.get("/.well-known/jwks.json", headers=headers)
            for headers in (
                {},
                AUTH,
                OTHER,
                {"Authorization": "Bearer wrong"},
                {"Cookie": "a=b"},
            )
        ]
        for response in responses:
            assert response.status_code == 200
            assert response.content == responses[0].content
            assert response.headers["cache-control"] == "public, max-age=3600"
            assert "vary" not in response.headers
            assert "set-cookie" not in response.headers
        assert len(s["validate_calls"]) == before
        expected = [
            {
                "kty": "RSA",
                "n": base64.urlsafe_b64encode((p * q).to_bytes(256, "big"))
                .rstrip(b"=")
                .decode(),
                "e": "AQAB",
                "kid": f"{epoch}.{meta}",
                "use": "sig",
                "alg": ALG,
            }
            for epoch, set_index in (("ep-2026-01", 0), ("ep-2025-12", 1))
            for meta, (p, q) in enumerate(TEST_KEYS[set_index])
        ]
        assert responses[0].json() == {"keys": expected}
        assert len({key["n"] for key in expected}) == 8


def test_rotation_publishes_previous_epoch_and_missing_current_epoch_is_503(tmp_path):
    write_test_epoch(tmp_path, "ep-2025-12", 1)
    write_test_epoch(tmp_path, "ep-2026-01", 0)
    now = [datetime(2026, 1, 1, tzinfo=timezone.utc)]
    issuer = PrivacyTokenIssuer(
        keys_dir=tmp_path,
        validate_user=lambda _context: "subject",
        meta_for=lambda _subject: 0,
        clock=lambda: now[0],
    )

    async def exercise():
        await issuer.initialize()
        published = await issuer.publish_keys()
        assert [k["kid"] for k in published["keys"]] == [
            f"{epoch}.{meta}"
            for epoch in ("ep-2026-01", "ep-2025-12")
            for meta in range(4)
        ]
        assert EpochKeys(tmp_path).publish(now[0]) == published
        now[0] = datetime(2026, 2, 1, tzinfo=timezone.utc)
        assert [k["kid"] for k in (await issuer.publish_keys())["keys"]] == [
            f"ep-2026-01.{meta}" for meta in range(4)
        ]
        with pytest.raises(KeyUnavailableError):
            await issuer.initialize()
        with pytest.raises(IssuanceError) as unavailable:
            await issuer.issue("session", {"meta": 0, "blinded": ["AAAA"]})
        assert (unavailable.value.status, unavailable.value.code) == (
            503,
            "key_unavailable",
        )

    asyncio.run(exercise())
    assert epoch_key_path(tmp_path, "ep-2026-01", 3).stat().st_mode & 0o777 == 0o600


def test_an_epoch_with_three_keys_fails_startup(tmp_path):
    write_test_epoch(tmp_path, "ep-2026-01", 0, metas=(0, 1, 3))
    issuer = PrivacyTokenIssuer(
        keys_dir=tmp_path,
        validate_user=lambda _context: "subject",
        meta_for=lambda _subject: 0,
        clock=lambda: datetime(2026, 1, 5, 12, tzinfo=timezone.utc),
    )
    with pytest.raises(ValueError, match="incomplete ep-2026-01"):
        with TestClient(create_app(issuer)):
            pass
    write_test_epoch(tmp_path, "ep-2026-01", 0, metas=(2,))
    write_test_epoch(tmp_path, "ep-2025-12", 1, metas=(0, 1, 2))
    with pytest.raises(ValueError, match="incomplete ep-2025-12"):
        EpochKeys(tmp_path).publish(datetime(2026, 1, 5, tzinfo=timezone.utc))


def test_other_schemes_wrong_parameters_and_reused_keys_are_refused(tmp_path):
    pem = fixture_key(1, 0).export_key(format="PEM", pkcs=8)
    # Earlier file names (one key per epoch, or another suite) are ignored entirely.
    (tmp_path / "ep-2026-01.key.pem").write_bytes(pem)
    (tmp_path / "ep-2026-01.pbrsa.key.pem").write_bytes(pem)
    when = datetime(2026, 1, 5, tzinfo=timezone.utc)
    with pytest.raises(KeyUnavailableError):
        EpochKeys(tmp_path).current(when)
    assert EpochKeys(tmp_path).publish(when) == {"keys": []}

    for bad in (
        rsa.generate_private_key(public_exponent=65537, key_size=1024),
        rsa.generate_private_key(public_exponent=3, key_size=2048),
    ):
        directory = tmp_path / f"bad-{bad.key_size}"
        write_test_epoch(directory, "ep-2026-01", 0, metas=(0, 1, 2))
        epoch_key_path(directory, "ep-2026-01", 3).write_bytes(
            bad.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        with pytest.raises(ValueError, match="RSA-2048 key with e = 65537"):
            EpochKeys(directory).current(when)

    reused = tmp_path / "reused"
    write_test_epoch(reused, "ep-2026-01", 0, metas=(0, 1, 2))
    write_epoch_key(reused, "ep-2026-01", 3, fixture_key(0, 1))
    with pytest.raises(ValueError, match="reuses a key"):
        EpochKeys(reused).current(when)


def test_corrupt_key_fails_closed(tmp_path):
    write_test_epoch(tmp_path, "ep-2026-01", 0, metas=(0, 1, 2))
    path = epoch_key_path(tmp_path, "ep-2026-01", 3)
    path.write_text("corrupt key")
    with pytest.raises(ValueError):
        EpochKeys(tmp_path).publish(datetime(2026, 1, 1, tzinfo=timezone.utc))
    assert path.read_text() == "corrupt key"


def test_key_writes_never_replace_an_existing_key(tmp_path):
    with ThreadPoolExecutor(max_workers=4) as pool:
        created = list(
            pool.map(
                lambda s: write_epoch_key(tmp_path, "ep-2026-01", 0, fixture_key(s, 0)),
                [0, 1, 0, 1],
            )
        )
    assert created.count(True) == 1
    winner = epoch_key_path(tmp_path, "ep-2026-01", 0).read_bytes()
    assert not write_epoch_key(tmp_path, "ep-2026-01", 0, fixture_key(1, 3))
    assert epoch_key_path(tmp_path, "ep-2026-01", 0).read_bytes() == winner


def test_generate_epoch_keys_creates_only_missing_keys_and_writes_the_jwks(tmp_path):
    write_test_epoch(tmp_path, "ep-2026-01", 0, metas=(0, 2))
    kept = [epoch_key_path(tmp_path, "ep-2026-01", m).read_bytes() for m in (0, 2)]
    generated = generate_epoch_keys(tmp_path, "ep-2026-01")
    assert generated.created == ["ep-2026-01.1", "ep-2026-01.3"]
    assert [
        epoch_key_path(tmp_path, "ep-2026-01", m).read_bytes() for m in (0, 2)
    ] == kept
    published = EpochKeys(tmp_path).publish(datetime(2026, 1, 5, tzinfo=timezone.utc))
    assert len(published["keys"]) == 4
    assert generated.jwks_path == epoch_jwks_path(tmp_path, "ep-2026-01")
    assert json.loads(generated.jwks_path.read_text()) == published
    assert generated.jwks_path.stat().st_mode & 0o777 == 0o644
    for meta, key in enumerate(published["keys"]):
        assert (
            epoch_key_path(tmp_path, "ep-2026-01", meta).stat().st_mode & 0o777 == 0o600
        )
        n = b64u_to_int(key["n"])
        assert (
            generated.modulus_sha256[f"ep-2026-01.{meta}"]
            == hashlib.sha256(n.to_bytes(256, "big")).hexdigest()
        )
    again = generate_epoch_keys(tmp_path, "ep-2026-01")
    assert again.created == []
    assert again.modulus_sha256 == generated.modulus_sha256


def test_http_errors_do_not_echo_input(setup):
    s = setup()
    with s["client"] as client:
        result = client.post("/issue", content=b"{bad-secret", headers=AUTH)
        assert result.status_code == 400
        assert "secret" not in result.text
        result = client.post(
            "/issue", json={"meta": 2, "blinded": ["x" * 70000]}, headers=AUTH
        )
        assert result.status_code == 413


def test_custom_auth_meta_and_quota_can_be_async(tmp_path):
    write_test_epoch(tmp_path, "ep-2026-01", 0)
    calls = []

    async def validate_user(context):
        return "stable-subject" if context == "valid-session" else None

    async def meta_for(subject):
        calls.append(("meta", subject))
        return 2

    class Store:
        async def take(self, client, count, when):
            calls.append(("quota", client, count))
            return False

    issuer = PrivacyTokenIssuer(
        keys_dir=tmp_path,
        validate_user=validate_user,
        meta_for=meta_for,
        quota=Store(),
        clock=lambda: datetime(2026, 1, 5, 12, tzinfo=timezone.utc),
    )

    async def exercise():
        for call in (
            issuer.issue("wrong", {"meta": 2, "blinded": ["AAAA"]}),
            issuer.meta("wrong"),
        ):
            with pytest.raises(IssuanceError) as rejected:
                await call
            assert rejected.value.status == 401
        assert calls == []
        assert await issuer.meta("valid-session") == {"meta": 2}
        jwk = (await issuer.publish_keys())["keys"][2]
        token = make_batch(b64u_to_int(jwk["n"]), 1)[0][2]
        with pytest.raises(IssuanceError) as limited:
            await issuer.issue("valid-session", {"meta": 2, "blinded": [token]})
        assert limited.value.status == 429

    asyncio.run(exercise())
    assert calls == [
        ("meta", "stable-subject"),
        ("meta", "stable-subject"),
        ("quota", "stable-subject", 1),
    ]


def test_demo_requires_explicit_opt_in_and_serves_its_meta(monkeypatch, tmp_path):
    monkeypatch.delenv("FRAY_LOCAL_DEMO", raising=False)
    monkeypatch.delenv("LOCAL_DEMO_TOKEN", raising=False)
    with pytest.raises(RuntimeError):
        create_demo_app()
    monkeypatch.setenv("FRAY_LOCAL_DEMO", "1")
    monkeypatch.setenv("LOCAL_DEMO_TOKEN", "local-example-token")
    monkeypatch.setenv("FRAY_ENV", "production")
    with pytest.raises(RuntimeError):
        create_demo_app()
    monkeypatch.delenv("FRAY_ENV")
    for meta in ("4", "-1", "1.0", " 1", "x", ""):
        monkeypatch.setenv("LOCAL_DEMO_META", meta)
        with pytest.raises(RuntimeError):
            create_demo_app()
    for quota in (0, -1, 17, True, 1.5):
        with pytest.raises(ValueError):
            DailyQuota(quota)
    for max_batch in (0, 17, True, 1.5):
        with pytest.raises(ValueError, match="max_batch"):
            PrivacyTokenIssuer(
                keys_dir=tmp_path,
                validate_user=lambda _c: "x",
                meta_for=lambda _s: 0,
                max_batch=max_batch,
            )
    # With this month's keys already present, the demo generates nothing.
    write_test_epoch(tmp_path, epoch_id(datetime.now(timezone.utc)), 0)
    monkeypatch.setenv("KEYS_DIR", str(tmp_path))
    monkeypatch.setenv("LOCAL_DEMO_META", "3")
    with TestClient(create_demo_app()) as client:
        assert client.get("/meta").status_code == 401
        assert client.get(
            "/meta", headers={"Authorization": "Bearer local-example-token"}
        ).json() == {"meta": 3}


def test_keygen_arguments():
    now = datetime(2026, 12, 15, tzinfo=timezone.utc)
    assert parse_args(["--keys-dir", "k"], {}, now) == ("k", ["ep-2026-12"])
    assert parse_args(["--epoch", "next"], {"KEYS_DIR": "env"}, now) == (
        "env",
        ["ep-2027-01"],
    )
    assert parse_args(
        [
            "--keys-dir",
            "k",
            "--epoch",
            "current",
            "--epoch",
            "ep-2027-02",
            "--epoch",
            "current",
        ],
        {},
        now,
    ) == ("k", ["ep-2026-12", "ep-2027-02"])
    for argv in (
        [],
        ["--epoch", "ep-2026-13", "--keys-dir", "k"],
        ["--epoch", "ep-2026-12.1", "--keys-dir", "k"],
        ["--keys-dir"],
        ["--force", "k"],
    ):
        with pytest.raises(ValueError):
            parse_args(argv, {}, now)


def test_metadata_values_are_0_to_3_only():
    assert [value for value in range(-2, 6) if is_token_meta(value)] == [0, 1, 2, 3]
    for bad in (1.5, "1", None, True, [1]):
        assert not is_token_meta(bad)


def test_out_of_order_midnight_requests_cannot_reset_allowances():
    quota = DailyQuota(2)
    before = datetime(2026, 1, 1, 23, 59, 59, tzinfo=timezone.utc)
    after = datetime(2026, 1, 2, tzinfo=timezone.utc)
    assert quota.take("user", 2, before)
    assert quota.take("user", 2, after)
    assert not quota.take("user", 1, before)
    assert not quota.take("user", 1, after)


def test_callbacks_required_and_hook_failures_are_not_returned_or_reraised(tmp_path):
    write_test_epoch(tmp_path, "ep-2026-01", 0)
    with pytest.raises(ValueError, match="meta_for"):
        PrivacyTokenIssuer(keys_dir=tmp_path, validate_user=lambda _c: "x", meta_for=None)  # type: ignore[arg-type]

    async def validate_user(_request):
        raise RuntimeError("private authentication diagnostic")

    issuer = PrivacyTokenIssuer(
        keys_dir=tmp_path,
        validate_user=validate_user,
        meta_for=lambda _subject: 0,
        clock=lambda: datetime(2026, 1, 5, 12, tzinfo=timezone.utc),
    )
    with TestClient(create_app(issuer)) as client:
        for response in (
            client.post("/issue", json={"meta": 0, "blinded": ["AAAA"]}),
            client.get("/meta"),
        ):
            assert response.status_code == 500
            assert response.json() == {"error": "internal_error"}
