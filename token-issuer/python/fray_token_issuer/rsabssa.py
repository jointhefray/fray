"""Issuer side of RFC 9474 RSABSSA-SHA384-PSS-Deterministic: BlindSign (section 4.3).

PSS encoding, blinding and finalization stay client-side. Each epoch has four keys, one per
metadata value, so a token's value is carried by which key signed it.
"""

import secrets
from dataclasses import dataclass
from typing import TypeGuard
from Crypto.Math.Numbers import Integer
from Crypto.PublicKey import RSA

SUITE = "RSABSSA-SHA384-PSS-Deterministic"
# One of four issuer-defined values. The protocol does not publish their meanings.
META_VALUES = (0, 1, 2, 3)


def is_token_meta(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 3


def _pow(base: Integer, exponent: Integer, modulus: Integer) -> Integer:
    """Modular exponentiation using PyCryptodome's integer arithmetic."""
    result: Integer = pow(base, exponent, modulus)
    return result


@dataclass(frozen=True)
class SigningKey:
    """An RSA private key with its CRT parameters."""

    n: int
    e: int
    d: int
    p: int
    q: int
    dp: int
    dq: int
    q_inv: int

    @classmethod
    def from_rsa(cls, key: RSA.RsaKey) -> "SigningKey":
        n, e, d, p, q = (int(value) for value in (key.n, key.e, key.d, key.p, key.q))
        return cls(n, e, d, p, q, d % (p - 1), d % (q - 1), pow(q, -1, p))


def blind_sign(key: SigningKey, blinded: bytes) -> bytes:
    """BlindSign: RSASP1 with RSA blinding and CRT, then the RSAVP1 check.

    Modular exponentiation is pow() on PyCryptodome's Integer arithmetic.

    Fault protection (spec/protocol.md section 2): this signer computes CRT itself and
    nothing verifies it internally, so the explicit RSAVP1 check below is mandatory. It
    keeps a faulty CRT half, which would reveal a factor of n, from ever being returned.
    """
    k_len = (key.n.bit_length() + 7) // 8
    m = int.from_bytes(blinded, "big")
    if len(blinded) != k_len or not 0 <= m < key.n:
        raise ValueError("message representative out of range")
    n, p, q, e = Integer(key.n), Integer(key.p), Integer(key.q), Integer(key.e)
    # RSA blinding: exponentiate m * r^e instead of m, so timing does not follow the
    # client-chosen input, then remove r. A fresh r for every signature.
    while True:
        r = secrets.randbelow(key.n - 2) + 2
        try:
            r_inv = pow(r, -1, key.n)
            break
        except ValueError:
            continue
    c = Integer(m) * _pow(Integer(r), e, n) % n
    # RSASP1 by CRT: s = s_q + q * ((s_p - s_q) * q^-1 mod p).
    s_p = _pow(c % p, Integer(key.dp), p)
    s_q = _pow(c % q, Integer(key.dq), q)
    # PyCryptodome 4 Integers cannot be negative. Reduce s_q modulo p before
    # adding p, so the subtraction is nonnegative for either prime ordering.
    difference = s_p + p - (s_q % p)
    s = (s_q + q * (difference * Integer(key.q_inv) % p)) * Integer(r_inv) % n
    # RSAVP1 check with (n, e): the fault protection. Never remove it.
    if int(_pow(s, e, n)) != m:
        raise RuntimeError("signing failure")
    return int(s).to_bytes(k_len, "big")
