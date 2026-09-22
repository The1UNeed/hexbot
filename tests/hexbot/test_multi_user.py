import sqlite3
import time

import pytest


class Transport:
    def __init__(self, user_id):
        self.auth_identity = {"user_id": user_id, "provider": "hexbot"}


@pytest.fixture
def as_device():
    from tui_gateway.transport import bind_transport, reset_transport

    tokens = []

    def bind(device_id):
        token = bind_transport(Transport(f"device:{device_id}"))
        tokens.append(token)

    yield bind
    while tokens:
        reset_transport(tokens.pop())


def add_user_and_device(user_id="member", role="member"):
    from hexbot import db
    db.migrate()
    with db.transaction() as conn:
        conn.execute("INSERT INTO users VALUES (?,?,?,?,?,NULL)",
                     (user_id, user_id.title(), role, "{}", time.time()))
        conn.execute("INSERT INTO devices VALUES (?,?,?,?,?,?,?,NULL)",
                     (f"d-{user_id}", "Phone", "test", f"hash-{user_id}", user_id,
                      time.time(), time.time()))
    return f"d-{user_id}"


def test_v5_seeds_admin_and_v8_drops_core_memory():
    from hexbot import db
    db.migrate()
    with db.transaction() as conn:
        admin = conn.execute("SELECT * FROM users WHERE id='local'").fetchone()
        assert (admin["display_name"], admin["role"]) == ("Admin", "admin")
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master")}
        assert not tables & {"core_memory", "memory_entries"}
        assert {row[1] for row in conn.execute("PRAGMA table_info(bots)")} >= {"shareable"}
        assert {row[1] for row in conn.execute("PRAGMA table_info(pairing_codes)")} >= {"user_id"}


def test_identity_and_owner_filtering(as_device, fake_gateway):
    from hexbot import bots, db
    from hexbot.errors import HexbotError
    from hexbot.identity import current_user_id, require_owner
    db.migrate()
    device = add_user_and_device()
    with db.transaction() as conn:
        now = time.time()
        conn.execute("INSERT INTO bots(name,display_name,owner_id,created_at,updated_at,last_activity_at) "
                     "VALUES ('mine','Mine','member',?,?,?)", (now, now, now))
        conn.execute("INSERT INTO bots(name,display_name,owner_id,created_at,updated_at,last_activity_at) "
                     "VALUES ('other','Other','local',?,?,?)", (now, now, now))
    as_device(device)
    assert current_user_id() == "member"
    assert [item["name"] for item in bots.list_bots()] == ["mine"]
    with pytest.raises(HexbotError) as caught:
        bots.get_bot("other")
    assert caught.value.code == 4302
    with pytest.raises(HexbotError) as caught:
        require_owner("local")
    assert caught.value.code == 4302


def test_invite_redeem_keeps_user_owner():
    from hexbot import pairing, users
    invited = users.invite("Sam", "member")
    device = pairing.redeem_code(invited["code"], device_name="Sam's phone", platform="test")
    assert pairing.verify_token(device.token).owner_id == invited["user"]["id"]


def test_shareable_bot_can_join_another_users_room(as_device):
    from hexbot import db
    from hexbot.rooms import store
    db.migrate()
    device = add_user_and_device()
    with db.transaction() as conn:
        now = time.time()
        conn.execute("INSERT INTO bots(name,owner_id,shareable,created_at,updated_at,last_activity_at) "
                     "VALUES ('shared','local',1,?,?,?)", (now, now, now))
    as_device(device)
    room = store.create("Shared room", ["shared"], "shared")
    member = next(row for row in room["members"] if row["member_kind"] == "bot")
    assert room["owner_id"] == "member"
    assert member["added_by"] == "member"


def test_member_cannot_use_admin_rpc(as_device):
    from hexbot.plugin import register
    class RecordingCtx:
        def __init__(self): self.methods = {}
        def register_rpc_method(self, name, fn): self.methods[name] = fn
        def register_system_prompt_section(self, *args, **kwargs): pass
        def register_hook(self, *args, **kwargs): pass
        def register_tool(self, *args, **kwargs): pass
    device = add_user_and_device()
    as_device(device)
    ctx = RecordingCtx(); register(ctx)
    frame = ctx.methods["hexbot.settings.get"](1, {})
    assert frame["error"]["code"] == 4301


def test_usage_is_attributed_by_section_owner_and_room_inviter(isolated_home):
    from hexbot import db, usage
    from hexbot.rooms import store
    db.migrate()
    add_user_and_device()
    now = time.time()
    with db.transaction() as conn:
        conn.execute("INSERT INTO bots(name,owner_id,created_at,updated_at,last_activity_at) "
                     "VALUES ('alpha','local',?,?,?)", (now, now, now))
        conn.execute("INSERT INTO bots(name,owner_id,created_at,updated_at,last_activity_at) "
                     "VALUES ('beta','local',?,?,?)", (now, now, now))
        conn.execute("INSERT INTO sections(id,bot,title,owner_id,created_at,updated_at) "
                     "VALUES ('member-section','alpha','A','member',?,?)", (now, now))
    room = store.create("R", owner_id="member")
    with db.transaction() as conn:
        conn.execute("INSERT INTO room_members VALUES (?,?,?,?,?,NULL,0)",
                     (room["id"], "bot", "beta", "member", now))
        conn.execute("INSERT INTO room_sessions VALUES (?,?,?,NULL)",
                     (room["id"], "beta", "member-room"))
    for bot, session, values in (("alpha", "member-section", (10, 4, .1)),
                                 ("beta", "member-room", (7, 3, .2))):
        path = isolated_home / "profiles" / bot / "state.db"
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE session_model_usage(session_id TEXT,input_tokens INTEGER,"
                     "output_tokens INTEGER,estimated_cost_usd REAL,actual_cost_usd REAL,last_seen REAL)")
        conn.execute("INSERT INTO session_model_usage VALUES (?,?,?,?,?,?)",
                     (session, values[0], values[1], values[2], 0, now))
        conn.commit(); conn.close()
    result = usage.summary(user_id="member", since=now - 1)
    assert (result["input_tokens"], result["output_tokens"]) == (17, 7)
    assert result["estimated_cost_usd"] == pytest.approx(.3)
