"""Resolve the Hexbot user attached to the current gateway transport."""

from __future__ import annotations

from hexbot import db
from hexbot.errors import HexbotError


def current_user_id() -> str:
    """Return the device owner, or ``local`` for an ungated local call."""
    try:
        from tui_gateway.server import current_transport
        transport = current_transport()
        identity = getattr(transport, "auth_identity", None) if transport else None
    except Exception:
        identity = None
    if not identity:
        return "local"
    auth_user = str(identity.get("user_id") or "")
    if not auth_user.startswith("device:"):
        return "local"
    device_id = auth_user.removeprefix("device:")
    db.migrate()
    with db.transaction() as conn:
        row = conn.execute(
            "SELECT d.owner_id FROM devices d JOIN users u ON u.id=d.owner_id "
            "WHERE d.id=? AND d.revoked_at IS NULL AND u.disabled_at IS NULL",
            (device_id,),).fetchone()
    if row is None:
        raise HexbotError(4302, "not the owner")
    return str(row[0])


def user(user_id: str | None = None):
    user_id = user_id or current_user_id()
    db.migrate()
    with db.transaction() as conn:
        row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if row is None or row["disabled_at"] is not None:
        raise HexbotError(4302, "not the owner")
    return row


def is_admin() -> bool:
    return user()["role"] == "admin"


def require_admin() -> str:
    row = user()
    if row["role"] != "admin":
        raise HexbotError(4301, "admin only")
    return str(row["id"])


def require_owner(owner_id: str) -> str:
    caller = current_user_id()
    if caller != owner_id:
        raise HexbotError(4302, "not the owner")
    return caller


def owner_filter(all_requested: bool = False) -> str | None:
    """Return None only for an admin's explicit all-users query."""
    if all_requested:
        require_admin()
        return None
    return current_user_id()
