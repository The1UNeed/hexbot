"""Single-use pairing codes and revocable device credentials."""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time
import uuid
from collections import deque
from dataclasses import dataclass
from threading import Lock
from urllib.parse import urlencode

from hexbot import db
from hexbot.errors import HexbotError
from hexbot.home import hexbot_home

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_TTL_SECONDS = 600
_FAILED_ATTEMPTS: deque[float] = deque()
_FAILED_ATTEMPTS_LOCK = Lock()


@dataclass(frozen=True)
class Device:
    id: str
    name: str
    platform: str
    token: str
    created_at: float
    last_seen_at: float


@dataclass(frozen=True)
class DeviceRow:
    id: str
    name: str
    platform: str
    owner_id: str
    created_at: float
    last_seen_at: float
    revoked_at: float | None


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def normalize_code(text: str) -> str:
    return str(text or "").strip().upper().replace("-", "").replace(" ", "")


def new_code() -> str:
    db.migrate()
    raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
    now = time.time()
    with db.transaction() as conn:
        conn.execute("UPDATE pairing_codes SET used_at=? WHERE used_at IS NULL", (now,))
        conn.execute(
            "INSERT INTO pairing_codes(code_hash,created_at,expires_at,used_at) VALUES (?,?,?,NULL)",
            (_digest(raw), now, now + CODE_TTL_SECONDS),
        )
    return f"{raw[:4]}-{raw[4:]}"


def code_expires_at(code: str) -> float | None:
    db.migrate()
    with db.transaction() as conn:
        row = conn.execute(
            "SELECT expires_at FROM pairing_codes WHERE code_hash=? AND used_at IS NULL",
            (_digest(normalize_code(code)),),
        ).fetchone()
    return float(row["expires_at"]) if row else None


def _row(row) -> DeviceRow:
    return DeviceRow(
        id=row["id"], name=row["name"], platform=row["platform"],
        owner_id=row["owner_id"], created_at=row["created_at"],
        last_seen_at=row["last_seen_at"], revoked_at=row["revoked_at"],
    )


def _mint_device(name: str, platform: str, *, conn=None) -> Device:
    token = "hxb_" + secrets.token_urlsafe(32)
    now = time.time()
    device = Device(str(uuid.uuid4()), name, platform, token, now, now)
    values = (device.id, device.name, device.platform, _digest(token), "local", now, now)
    sql = ("INSERT INTO devices(id,name,platform,token_hash,owner_id,created_at,last_seen_at) "
           "VALUES (?,?,?,?,?,?,?)")
    if conn is not None:
        conn.execute(sql, values)
    else:
        with db.transaction() as own_conn:
            own_conn.execute(sql, values)
    return device


def mint_device(name: str, platform: str) -> Device:
    """Create a revocable device credential outside the pairing-code flow."""
    db.migrate()
    return _mint_device(name, platform)


def _record_failure(now: float) -> None:
    with _FAILED_ATTEMPTS_LOCK:
        while _FAILED_ATTEMPTS and _FAILED_ATTEMPTS[0] <= now - 60:
            _FAILED_ATTEMPTS.popleft()
        if len(_FAILED_ATTEMPTS) >= 10:
            raise HexbotError(4232, "too many attempts")
        _FAILED_ATTEMPTS.append(now)


def redeem_code(code: str, *, device_name: str, platform: str) -> Device:
    db.migrate()
    now = time.time()
    with db.transaction() as conn:
        digest = _digest(normalize_code(code))
        row = conn.execute(
            "SELECT code_hash FROM pairing_codes WHERE code_hash=? "
            "AND used_at IS NULL AND expires_at>?", (digest, now),
        ).fetchone()
        if row is None:
            _record_failure(now)
            raise HexbotError(4231, "invalid or expired pairing code")
        changed = conn.execute(
            "UPDATE pairing_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL",
            (now, row["code_hash"]),
        ).rowcount
        if changed != 1:
            _record_failure(now)
            raise HexbotError(4231, "invalid or expired pairing code")
        return _mint_device(device_name, platform, conn=conn)


def verify_token(token: str) -> DeviceRow | None:
    if not token:
        return None
    db.migrate()
    digest = _digest(token)
    now = time.time()
    with db.transaction() as conn:
        row = conn.execute(
            "SELECT * FROM devices WHERE token_hash=? AND revoked_at IS NULL", (digest,)
        ).fetchone()
        if row is None or not hmac.compare_digest(row["token_hash"], digest):
            return None
        if now - row["last_seen_at"] >= 60:
            conn.execute("UPDATE devices SET last_seen_at=? WHERE id=?", (now, row["id"]))
            row = conn.execute("SELECT * FROM devices WHERE id=?", (row["id"],)).fetchone()
    return _row(row)


def list_devices() -> list[DeviceRow]:
    db.migrate()
    with db.transaction() as conn:
        rows = conn.execute(
            "SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY created_at DESC"
        ).fetchall()
    return [_row(row) for row in rows]


def revoke_device(device_id: str) -> bool:
    db.migrate()
    with db.transaction() as conn:
        changed = conn.execute(
            "UPDATE devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL",
            (time.time(), device_id),
        ).rowcount
    if not changed:
        raise HexbotError(4204, f"device not found: {device_id}")
    return True


def local_device() -> tuple[DeviceRow, str]:
    db.migrate()
    token_path = hexbot_home() / "local-device.token"
    with db.transaction() as conn:
        existing = conn.execute(
            "SELECT * FROM devices WHERE name='This computer' AND platform='local' "
            "AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
    if existing is not None and token_path.exists():
        token = token_path.read_text().strip()
        verified = verify_token(token)
        if verified is not None and verified.id == existing["id"]:
            return verified, token
    if existing is not None:
        revoke_device(existing["id"])
    device = _mint_device("This computer", "local")
    fd = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(device.token + "\n")
    verified = verify_token(device.token)
    assert verified is not None
    return verified, device.token


def pair_link(host: str, port: int, code: str) -> str:
    return "hexbot://pair?" + urlencode({"host": host, "port": port}) + "#code=" + code
