"""Per-user model usage attribution and daily budget checks."""

from __future__ import annotations

import json
import sqlite3
import time

from hexbot import db
from hexbot.errors import HexbotError
from hexbot.home import hexbot_home
from hexbot.identity import current_user_id, require_admin


def _routes(user_id: str) -> dict[str, set[str]]:
    """Map bot profile names to session ids billed to a user."""
    result: dict[str, set[str]] = {}
    with db.transaction() as conn:
        for row in conn.execute("SELECT id,bot FROM sections WHERE owner_id=?", (user_id,)):
            result.setdefault(row["bot"], set()).add(row["id"])
        rows = conn.execute(
            "SELECT rs.bot,rs.stored_session_id FROM room_sessions rs "
            "JOIN room_members rm ON rm.room_id=rs.room_id AND rm.member_kind='bot' "
            "AND rm.member_id=rs.bot WHERE rm.added_by=?", (user_id,)).fetchall()
        for row in rows:
            result.setdefault(row["bot"], set()).add(row["stored_session_id"])
    return result


def summary(*, user_id=None, since=0) -> dict:
    db.migrate()
    caller = current_user_id()
    user_id = user_id or caller
    if user_id != caller:
        require_admin()
    totals = {"input_tokens": 0, "output_tokens": 0, "estimated_cost_usd": 0.0}
    by_bot = []
    for bot, session_ids in sorted(_routes(user_id).items()):
        path = hexbot_home() / "profiles" / bot / "state.db"
        values = [0, 0, 0.0]
        if path.exists() and session_ids:
            try:
                conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
                marks = ",".join("?" for _ in session_ids)
                row = conn.execute(
                    "SELECT COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0),"
                    "COALESCE(SUM(estimated_cost_usd),0) FROM session_model_usage "
                    f"WHERE session_id IN ({marks}) AND last_seen>=?",
                    [*session_ids, float(since or 0)]).fetchone()
                conn.close()
                values = [int(row[0]), int(row[1]), float(row[2] or 0)]
            except (sqlite3.Error, OSError):
                values = [0, 0, 0.0]
        item = {"bot": bot, "input_tokens": values[0], "output_tokens": values[1],
                "estimated_cost_usd": values[2]}
        by_bot.append(item)
        for key in totals:
            totals[key] += item[key]
    return {**totals, "by_bot": by_bot}


def daily_limit(user_id: str) -> tuple[int | None, int]:
    with db.transaction() as conn:
        row = conn.execute("SELECT limits_json FROM users WHERE id=?", (user_id,)).fetchone()
    if row is None:
        raise HexbotError(4302, "not the owner")
    limit = json.loads(row[0] or "{}").get("daily_tokens")
    start = time.time() - time.time() % 86400
    data = summary(user_id=user_id, since=start)
    return limit, data["input_tokens"] + data["output_tokens"]


def require_budget(user_id: str) -> None:
    limit, used = daily_limit(user_id)
    if limit is not None and used >= int(limit):
        try:
            from hexbot.gateway import broadcast
            broadcast("hexbot.usage.limit", {"user": user_id})
        finally:
            raise HexbotError(4303, "daily token budget reached",
                              {"user": user_id, "used": used, "limit": limit})
