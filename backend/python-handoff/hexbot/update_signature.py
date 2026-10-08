"""Release signatures for native update manifests (docs/release.md, "Update signing").

The handoff has no dependencies, so this is the RFC 8032 reference Ed25519
verifier. It runs once per transition, on a manifest of a few hundred bytes.
"""
from __future__ import annotations

import base64
import binascii
import hashlib

# packaging/update-signing-key.pub, one key per line; a release script test keeps the two equal.
RELEASE_KEYS = ("2QNwY0NSlYpe4qfdxX4S8E0uVORcke27ZWM0Y0wJpQk=",)

_P = 2**255 - 19
_Q = 2**252 + 27742317777372353535851937790883648493
_D = -121665 * pow(121666, -1, _P) % _P
_SQRT_M1 = pow(2, (_P - 1) // 4, _P)


def _hash(data: bytes) -> int:
    return int.from_bytes(hashlib.sha512(data).digest(), "little") % _Q


def _add(a, b):
    x = (a[1] - a[0]) * (b[1] - b[0]) % _P
    y = (a[1] + a[0]) * (b[1] + b[0]) % _P
    z = 2 * a[3] * b[3] * _D % _P
    t = 2 * a[2] * b[2] % _P
    e, f, g, h = y - x, t - z, t + z, y + x
    return (e * f, g * h, f * g, e * h)


def _multiply(scalar: int, point):
    result = (0, 1, 1, 0)
    while scalar > 0:
        if scalar & 1:
            result = _add(result, point)
        point = _add(point, point)
        scalar >>= 1
    return result


def _equal(a, b) -> bool:
    return (a[0] * b[2] - b[0] * a[2]) % _P == 0 and (a[1] * b[2] - b[1] * a[2]) % _P == 0


def _recover_x(y: int, sign: int):
    if y >= _P:
        return None
    x2 = (y * y - 1) * pow(_D * y * y + 1, -1, _P)
    if x2 % _P == 0:
        return None if sign else 0
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P:
        x = x * _SQRT_M1 % _P
    if (x * x - x2) % _P:
        return None
    return _P - x if (x & 1) != sign else x


def _decompress(data: bytes):
    y = int.from_bytes(data, "little")
    sign, y = y >> 255, y & ((1 << 255) - 1)
    x = _recover_x(y, sign)
    return None if x is None else (x, y, 1, x * y % _P)


def _compress(point) -> bytes:
    inverse = pow(point[2], -1, _P)
    x, y = point[0] * inverse % _P, point[1] * inverse % _P
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


_GY = 4 * pow(5, -1, _P) % _P
_GX = _recover_x(_GY, 0)
_G = (_GX, _GY, 1, _GX * _GY % _P)


def verify(manifest: bytes, signature: bytes, keys=RELEASE_KEYS) -> bool:
    """True when `signature` (base64, as in a .sig file) signs exactly `manifest`."""
    try:
        signature = base64.b64decode(signature.strip(), validate=True)
    except (binascii.Error, ValueError):
        return False
    if len(signature) != 64:
        return False
    point = _decompress(signature[:32])
    scalar = int.from_bytes(signature[32:], "little")
    if point is None or scalar >= _Q:
        return False
    for key in keys:
        public = base64.b64decode(key)
        owner = _decompress(public) if len(public) == 32 else None
        if owner is None:
            continue
        challenge = _hash(signature[:32] + public + manifest)
        if _equal(_multiply(scalar, _G), _add(point, _multiply(challenge, owner))):
            return True
    return False


def sign(seed: bytes, manifest: bytes) -> tuple[str, str]:
    """(public key, signature) in base64, from a 32-byte seed. For tests."""
    digest = hashlib.sha512(seed).digest()
    secret = (int.from_bytes(digest[:32], "little") & ((1 << 254) - 8)) | (1 << 254)
    public = _compress(_multiply(secret, _G))
    nonce = _hash(digest[32:] + manifest)
    commitment = _compress(_multiply(nonce, _G))
    scalar = (nonce + _hash(commitment + public + manifest) * secret) % _Q
    return base64.b64encode(public).decode(), base64.b64encode(commitment + scalar.to_bytes(32, "little")).decode()
