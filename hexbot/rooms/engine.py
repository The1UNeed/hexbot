"""Room turn scheduling over ordinary profile sessions.

The completion watcher polls ``session.history`` after ``message.complete``
would have been emitted. This works without owning a client transport and the
same watcher can serve room turns and bot-to-bot messages.
"""

from __future__ import annotations

import concurrent.futures
import logging
import re
import sqlite3
import threading
import time
import uuid

from hexbot import db, gateway, settings
from hexbot.home import hexbot_home
from . import prompt, store

logger = logging.getLogger(__name__)
MENTION = re.compile(r"(?<![\w-])@([\w-]+)", re.I)


class InlineExecutor:
    """Future-compatible executor used by deterministic tests."""
    def submit(self, fn, *args, **kwargs):
        future = concurrent.futures.Future()
        try: future.set_result(fn(*args, **kwargs))
        except BaseException as exc: future.set_exception(exc)
        return future
    def shutdown(self, wait=True): pass


def reply_text(messages, baseline=0):
    assistants = [m for m in messages if m.get("role") == "assistant"]
    if len(assistants) <= baseline:
        return None
    value = assistants[-1].get("content", assistants[-1].get("text", ""))
    if isinstance(value, list):
        value = "".join(str(x.get("text", "")) for x in value if isinstance(x, dict))
    return str(value or "")


class CompletionWatcher:
    def __init__(self, *, sleep=time.sleep, monotonic=time.monotonic, timeout=600.0,
                 interval=.1):
        self.sleep, self.monotonic = sleep, monotonic
        self.timeout, self.interval = timeout, interval

    def baseline(self, live_id):
        history = gateway.call("session.history", {"session_id": live_id}).get("messages", [])
        return sum(m.get("role") == "assistant" for m in history)

    def wait(self, live_id, baseline):
        end = self.monotonic() + self.timeout
        while self.monotonic() <= end:
            history = gateway.call("session.history", {"session_id": live_id}).get("messages", [])
            answer = reply_text(history, baseline)
            if answer is not None:
                return answer
            self.sleep(self.interval)
        raise TimeoutError(f"session {live_id} did not complete within {self.timeout:g}s")


def select_responders(room, event, already=()):
    """Apply the responder rules to one user or bot message."""
    text = str(event.get("payload", {}).get("text", ""))
    active = [m["member_id"] for m in room["members"]
              if m["member_kind"] == "bot" and m["left_at"] is None]
    mentions = {value.lower() for value in MENTION.findall(text)}
    if event["kind"] == "message.bot" and (
            "user" in mentions or ("?" in text and re.search(r"\b(user|human|you)\b", text, re.I))):
        return [], True
    selected = [bot for bot in active if bot.lower() in mentions and bot not in already]
    if (event["kind"] == "message.user" and not selected and
            room.get("main_bot") in active and room.get("main_bot") not in already):
        selected = [room["main_bot"]]
    return selected, False


def _usage(bot, stored_session_id=None, *, since=None):
    path = hexbot_home() / "profiles" / bot / "state.db"
    if not path.exists(): return {"input": 0, "output": 0, "cost": 0.0}
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        where, args = [], []
        if stored_session_id:
            where.append("session_id=?"); args.append(stored_session_id)
        if since is not None:
            where.append("last_seen>=?"); args.append(since)
        suffix = " WHERE " + " AND ".join(where) if where else ""
        row = conn.execute("SELECT COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0),COALESCE(SUM(CASE WHEN actual_cost_usd>0 THEN actual_cost_usd ELSE estimated_cost_usd END),0) FROM session_model_usage" + suffix, args).fetchone()
        conn.close()
        return {"input": int(row[0]), "output": int(row[1]), "cost": float(row[2] or 0)}
    except (sqlite3.Error, OSError):
        logger.debug("usage unavailable for %s", bot, exc_info=True)
        return {"input": 0, "output": 0, "cost": 0.0}


class RoomEngine:
    def __init__(self, *, executor=None, watcher=None, start_thread=True, pool_size=4):
        self.executor = executor or concurrent.futures.ThreadPoolExecutor(max_workers=pool_size, thread_name_prefix="hexbot-room")
        self.watcher = watcher or CompletionWatcher()
        self._pending, self._stopped = set(), set()
        self._condition = threading.Condition()
        self._closed = False
        self._session_locks = {}
        self._session_locks_guard = threading.Lock()
        self._thread = None
        self.reconcile()
        if start_thread:
            self._thread = threading.Thread(target=self._supervise, name="hexbot-rooms", daemon=True)
            self._thread.start()

    def reconcile(self):
        db.migrate()
        with db.transaction() as conn:
            conn.execute("UPDATE room_turns SET status='failed',finished_at=? WHERE status='running'", (time.time(),))
            rooms = conn.execute("SELECT DISTINCT room_id FROM room_events WHERE kind='message.user'").fetchall()
        self._pending.update(row[0] for row in rooms)

    def notify(self, room_id):
        with self._condition:
            self._stopped.discard(room_id); self._pending.add(room_id); self._condition.notify()

    def stop(self, room_id):
        self._stopped.add(room_id); self._pending.discard(room_id)
        room = store.get(room_id)
        for member in room["members"]:
            if member["member_kind"] != "bot": continue
            with db.transaction() as conn:
                row = conn.execute("SELECT live_session_id FROM room_sessions WHERE room_id=? AND bot=?", (room_id, member["member_id"])).fetchone()
            if row and row[0]:
                try: gateway.call("session.interrupt", {"session_id": row[0]})
                except Exception: logger.debug("room interrupt failed", exc_info=True)
        return True

    def close(self):
        with self._condition: self._closed = True; self._condition.notify_all()
        self.executor.shutdown(wait=False)

    def _supervise(self):
        while True:
            with self._condition:
                self._condition.wait_for(lambda: self._pending or self._closed)
                if self._closed: return
            self.run_pending()

    def run_pending(self):
        while self._pending:
            room_id = self._pending.pop()
            if room_id not in self._stopped:
                self._drain(room_id)

    def _drain(self, room_id):
        while room_id not in self._stopped:
            room = store.get(room_id, enforce_owner=False)
            with db.transaction() as conn:
                room["member_titles"] = {row["name"]: row["title"] or row["display_name"] or ""
                                         for row in conn.execute("SELECT name,title,display_name FROM bots")}
            events = store.log(room_id, 0, 1000, enforce_owner=False)
            candidate = None
            for event in events:
                if event["kind"] not in {"message.user", "message.bot"}: continue
                with db.transaction() as conn:
                    done = {r[0] for r in conn.execute("SELECT bot FROM room_turns WHERE room_id=? AND trigger_seq=?", (room_id, event["seq"]))}
                    waited = conn.execute("SELECT 1 FROM room_events WHERE room_id=? AND kind='waiting.human' AND json_extract(payload_json,'$.trigger_seq')=?", (room_id, event["seq"])).fetchone()
                selected, waiting = select_responders(room, event, done)
                if waiting and not waited:
                    store.append_event(room_id, "waiting.human", "bot", event["actor_id"], {"trigger_seq": event["seq"]}, enforce_owner=False)
                    return
                if waiting:
                    continue
                if selected: candidate = (event, selected); break
            if not candidate: return
            event, selected = candidate
            replies = self._fanout(room, event, selected)
            if event["kind"] == "message.bot" and event["actor_id"] == room.get("main_bot") and replies:
                self._run_turn(room, room["main_bot"], event, replies)

    def _limits(self, room, bot, trigger_seq):
        from hexbot.usage import daily_limit
        values = settings.get_settings(); values.update(room.get("limits") or {})
        with db.transaction() as conn:
            last_human = conn.execute("SELECT COALESCE(MAX(seq),0) FROM room_events WHERE room_id=? AND kind='message.user' AND seq<=?", (room["id"], trigger_seq)).fetchone()[0]
            turns = conn.execute("SELECT COUNT(*),COALESCE(SUM(input_tokens+output_tokens),0) FROM room_turns WHERE room_id=? AND trigger_seq>=? AND status IN ('running','complete')", (room["id"], last_human)).fetchone()
        checks = [
            (daily_limit(room["owner_id"])[0], daily_limit(room["owner_id"])[1], "daily_tokens"),
            (values.get("room_bot_turns_per_human_turn"), turns[0], "room_bot_turns_per_human_turn"),
            (values.get("room_budget_tokens_per_human_turn"), turns[1], "room_budget_tokens_per_human_turn"),
            (values.get("bot_daily_token_budget"), _usage(bot, since=time.time()-time.time()%86400)["input"] + _usage(bot, since=time.time()-time.time()%86400)["output"], "bot_daily_token_budget")]
        for cap, used, name in checks:
            if cap is not None and used >= int(cap):
                store.append_event(room["id"], "limit.tripped", "system", None, {"limit": name, "used": used, "cap": cap}, enforce_owner=False)
                with db.transaction() as conn:
                    conn.execute("INSERT INTO room_turns(id,room_id,bot,trigger_seq,started_at,finished_at,status,input_tokens,output_tokens,cost_usd) VALUES (?,?,?,?,?,?,'limit',0,0,0)", (uuid.uuid4().hex, room["id"], bot, trigger_seq, time.time(), time.time()))
                self._stopped.add(room["id"])
                return False
        return True

    def _fanout(self, room, event, bots):
        allowed = [self._limits(room, bot, event["seq"]) for bot in bots]
        if not all(allowed):
            with db.transaction() as conn:
                for bot, passed in zip(bots, allowed):
                    if passed:
                        conn.execute("INSERT INTO room_turns(id,room_id,bot,trigger_seq,started_at,finished_at,status,input_tokens,output_tokens,cost_usd) VALUES (?,?,?,?,?,?,'limit',0,0,0)", (uuid.uuid4().hex, room["id"], bot, event["seq"], time.time(), time.time()))
            return []
        futures = [(bot, self.executor.submit(self._run_turn, room, bot, event, None, True)) for bot in bots]
        replies = []
        for bot, future in futures:
            try:
                text = future.result()
                if text: replies.append((bot, text))
            except Exception:
                logger.exception("room turn failed for %s", bot)
        return replies

    def _session(self, room, bot):
        with db.transaction() as conn:
            row = conn.execute("SELECT * FROM room_sessions WHERE room_id=? AND bot=?", (room["id"], bot)).fetchone()
        if row and row["live_session_id"]:
            try:
                gateway.call("session.history", {"session_id": row["live_session_id"]})
                return row["stored_session_id"], row["live_session_id"]
            except Exception: pass
        if row:
            result = gateway.call("session.resume", {"session_id": row["stored_session_id"], "profile": bot})
            stored = row["stored_session_id"]
        else:
            result = gateway.call("session.create", {"profile": bot, "title": f"Room: {room['name']}", "source": "hexbot_room", "hidden": True, "room_plumbing": True, "follow_profile_config": True, "close_on_disconnect": False})
            stored = result.get("stored_session_id")
        live = result.get("session_id")
        with db.transaction() as conn:
            conn.execute("INSERT OR REPLACE INTO room_sessions VALUES (?,?,?,?)", (room["id"], bot, stored, live))
        return stored, live

    def _run_turn(self, room, bot, event, collecting, limit_checked=False):
        key = (room["id"], bot)
        with self._session_locks_guard:
            lock = self._session_locks.setdefault(key, threading.RLock())
        with lock:
            return self._execute_turn(room, bot, event, collecting, limit_checked)

    def _execute_turn(self, room, bot, event, collecting, limit_checked=False):
        if room["id"] in self._stopped: return None
        if not limit_checked and not self._limits(room, bot, event["seq"]): return None
        stored, live = self._session(room, bot)
        with db.transaction() as conn:
            member = conn.execute("SELECT last_read_seq FROM room_members WHERE room_id=? AND member_kind='bot' AND member_id=?", (room["id"], bot)).fetchone()
        delta = store.log(room["id"], member[0] if member else 0, 1000, enforce_owner=False)
        text = prompt.render(room, bot, delta, collecting)
        turn_id, now = uuid.uuid4().hex, time.time()
        before = _usage(bot, stored)
        with db.transaction() as conn:
            conn.execute("INSERT INTO room_turns VALUES (?,?,?,?,?,NULL,'running',0,0,0)", (turn_id, room["id"], bot, event["seq"], now))
        store.append_event(room["id"], "turn.started", "bot", bot,
                           {"turn_id": turn_id, "trigger_seq": event["seq"],
                            "live_session_id": live}, enforce_owner=False)
        gateway.broadcast("hexbot.rooms.turn", {"room_id": room["id"], "bot": bot, "live_session_id": live, "status": "running"})
        try:
            baseline = self.watcher.baseline(live)
            gateway.call("prompt.submit", {"session_id": live, "text": text, "display_kind": "hidden"})
            answer = self.watcher.wait(live, baseline).strip()
            after = _usage(bot, stored)
            usage = {k: max(0, after[k] - before[k]) for k in before}
            with db.transaction() as conn:
                conn.execute("UPDATE room_turns SET finished_at=?,status='complete',input_tokens=?,output_tokens=?,cost_usd=? WHERE id=?", (time.time(), usage["input"], usage["output"], usage["cost"], turn_id))
                conn.execute("UPDATE room_members SET last_read_seq=? WHERE room_id=? AND member_kind='bot' AND member_id=?", (max((x["seq"] for x in delta), default=event["seq"]), room["id"], bot))
            if answer and answer.lower() != "(pass)":
                store.append_event(room["id"], "message.bot", "bot", bot, {"text": answer, "trigger_seq": event["seq"]}, enforce_owner=False)
            gateway.broadcast("hexbot.rooms.turn", {"room_id": room["id"], "bot": bot, "live_session_id": live, "status": "complete"})
            return answer if answer.lower() != "(pass)" else None
        except Exception as exc:
            with db.transaction() as conn:
                conn.execute("UPDATE room_turns SET finished_at=?,status='failed' WHERE id=?", (time.time(), turn_id))
            store.append_event(room["id"], "turn.failed", "bot", bot, {"error": str(exc), "trigger_seq": event["seq"]}, enforce_owner=False)
            gateway.broadcast("hexbot.rooms.turn", {"room_id": room["id"], "bot": bot, "live_session_id": live, "status": "failed"})
            return None


_ENGINE = None
def get_engine():
    global _ENGINE
    if _ENGINE is None: _ENGINE = RoomEngine()
    return _ENGINE
def set_engine(engine):
    global _ENGINE
    _ENGINE = engine
