#!/usr/bin/env bash
set -u

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT" || exit 1
SMOKE_HOME=$(mktemp -d)
LOG="$SMOKE_HOME/server.log"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  rm -rf "$SMOKE_HOME"
}
trap cleanup EXIT

pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; tail -40 "$LOG" 2>/dev/null; exit 1; }

HEXBOT_HOME="$SMOKE_HOME" ./venv/bin/hexbot serve --lan --port 9132 >"$LOG" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:9132/api/auth/providers >"$SMOKE_HOME/providers.json" && break
  sleep 0.5
done
grep -q '"hexbot"' "$SMOKE_HOME/providers.json" || fail "auth provider"
pass "auth provider"

HEXBOT_HOME="$SMOKE_HOME" ./venv/bin/hexbot pair >"$SMOKE_HOME/pair.txt" || fail "pair command"
CODE=$(sed -n 's/^Pairing code: //p' "$SMOKE_HOME/pair.txt")
[[ "$CODE" =~ ^[A-Z2-9]{4}-[A-Z2-9]{4}$ ]] || fail "pair code"
pass "pair code"

BODY=$(printf '{"provider":"hexbot","username":"smoke","password":"%s"}' "$CODE")
curl -si -X POST http://127.0.0.1:9132/auth/password-login \
  -H 'content-type: application/json' -d "$BODY" >"$SMOKE_HOME/login.txt" || fail "password login"
grep -q '^HTTP/.* 200' "$SMOKE_HOME/login.txt" || fail "password login"
TOKEN=$(sed -n 's/^set-cookie: hermes_session_at=\([^;]*\).*/\1/ip' "$SMOKE_HOME/login.txt" | tr -d '\r')
[[ "$TOKEN" == hxb_* ]] || fail "device token cookie"
pass "password login and cookie"

curl -fsS -X POST http://127.0.0.1:9132/api/auth/ws-ticket \
  -H "Authorization: Bearer $TOKEN" >"$SMOKE_HOME/ticket.json" || fail "ws ticket"
pass "bearer ws ticket"

HEXBOT_HOME="$SMOKE_HOME" TOKEN="$TOKEN" ./venv/bin/python - <<'PY' || fail "websocket RPC and revoke"
import asyncio, json, os
import websockets

with open(os.path.join(os.environ["HEXBOT_HOME"], "ticket.json")) as stream:
    ticket = json.load(stream)["ticket"]

async def main():
    async with websockets.connect(f"ws://127.0.0.1:9132/api/ws?ticket={ticket}") as ws:
        async def call(rid, method, params=None):
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method,
                                      "params": params or {}}))
            while True:
                frame = json.loads(await ws.recv())
                if frame.get("id") == rid:
                    assert "error" not in frame, frame
                    return frame["result"]
        info = await call(1, "hexbot.info")
        assert info["auth_required"] is True and info["pairing_supported"] is True, info
        devices = await call(2, "hexbot.devices.list")
        current = next(item for item in devices["devices"] if item["name"] == "smoke")
        assert current["current"] is True, devices
        revoked = await call(3, "hexbot.devices.revoke", {"id": current["id"]})
        assert revoked == {"revoked": True}, revoked

asyncio.run(main())
PY
pass "websocket RPC and revoke"

STATUS=$(curl -sS -o "$SMOKE_HOME/revoked.txt" -w '%{http_code}' -X POST \
  http://127.0.0.1:9132/api/auth/ws-ticket -H "Authorization: Bearer $TOKEN")
[[ "$STATUS" == 401 ]] || fail "revoked bearer rejected"
pass "revoked bearer rejected"
