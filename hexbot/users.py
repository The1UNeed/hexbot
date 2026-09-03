"""Household users and user-bound invitations."""

from __future__ import annotations

import json
import time
import uuid

from hexbot import db, pairing
from hexbot.errors import HexbotError
from hexbot.identity import current_user_id, require_admin


def _shape(row) -> dict:
    return {"id": row["id"], "display_name": row["display_name"],
            "role": row["role"], "limits": json.loads(row["limits_json"] or "{}"),
            "created_at": row["created_at"], "disabled_at": row["disabled_at"]}


def me() -> dict:
    uid = current_user_id()
    with db.transaction() as conn:
        row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if row is None:
        raise HexbotError(4302, "not the owner")
    return {key: _shape(row)[key] for key in ("id", "display_name", "role")}


def list_users() -> list[dict]:
    require_admin()
    with db.transaction() as conn:
        rows = conn.execute("SELECT * FROM users ORDER BY created_at,id").fetchall()
    return [_shape(row) for row in rows]


def invite(display_name: str, role: str = "member") -> dict:
    require_admin()
    display_name = str(display_name or "").strip()
    if not display_name:
        raise HexbotError(4200, "missing parameter: display_name")
    if role not in {"admin", "member"}:
        raise HexbotError(4202, "role must be admin or member")
    user_id = uuid.uuid4().hex
    with db.transaction() as conn:
        conn.execute("INSERT INTO users VALUES (?,?,?,?,?,NULL)",
                     (user_id, display_name, role, "{}", time.time()))
    code = pairing.new_code(user_id=user_id)
    return {"user": get_user(user_id), "code": code,
            "expires_at": pairing.code_expires_at(code)}


def get_user(user_id: str) -> dict:
    with db.transaction() as conn:
        row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if row is None:
        raise HexbotError(4204, f"user not found: {user_id}")
    return _shape(row)


def update_user(user_id: str, **patch) -> dict:
    require_admin()
    if set(patch) - {"display_name", "role", "disabled", "limits"}:
        raise HexbotError(4201, "unknown user field")
    if "role" in patch and patch["role"] not in {"admin", "member"}:
        raise HexbotError(4202, "role must be admin or member")
    if "limits" in patch:
        limits = patch["limits"]
        if not isinstance(limits, dict):
            raise HexbotError(4202, "limits must be an object")
        value = limits.get("daily_tokens")
        if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value < 0):
            raise HexbotError(4202, "daily_tokens must be a non-negative integer or null")
    assignments, values = [], []
    for key, value in patch.items():
        column = {"disabled": "disabled_at", "limits": "limits_json"}.get(key, key)
        if key == "disabled": value = time.time() if value else None
        if key == "limits": value = json.dumps(value)
        assignments.append(f"{column}=?"); values.append(value)
    if assignments:
        with db.transaction() as conn:
            conn.execute(f"UPDATE users SET {','.join(assignments)} WHERE id=?",
                         values + [user_id])
    return get_user(user_id)
