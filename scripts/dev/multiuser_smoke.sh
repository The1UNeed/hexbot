#!/usr/bin/env bash
# Live check of invites and ownership on a LAN-gated daemon. Prints PASS/FAIL per step.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; PORT=${PORT:-9140}
export HEXBOT_HOME="$(mktemp -d)"; export HERMES_HOME="$HEXBOT_HOME"
"$ROOT/venv/bin/python" -c "from hermes_cli import auth; auth._save_codex_tokens(auth._import_codex_cli_tokens())" >/dev/null 2>&1
"$ROOT/venv/bin/hexbot" serve --lan --port "$PORT" > "$HEXBOT_HOME/serve.log" 2>&1 &
SERVER=$!; trap 'kill $SERVER 2>/dev/null' EXIT
for i in $(seq 1 90); do grep -qE "_READY" "$HEXBOT_HOME/serve.log" 2>/dev/null && break; sleep 1; done
login() { # $1=code $2=device -> prints token
  curl -s -i -X POST "http://127.0.0.1:$PORT/auth/password-login" -H 'content-type: application/json' -d "{\"provider\":\"hexbot\",\"username\":\"$2\",\"password\":\"$1\"}" | grep -i "set-cookie: hermes_session_at=" | sed -E 's/.*hermes_session_at=([^;]+).*/\1/' | head -1
}
rpc() { # $1=token $2=calls-json
  "$ROOT/venv/bin/python" - "$PORT" "$1" "$2" <<'PY'
import asyncio, json, sys, urllib.request, websockets
port, token, calls = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
req = urllib.request.Request(f"http://127.0.0.1:{port}/api/auth/ws-ticket", method="POST", headers={"Authorization": f"Bearer {token}"})
ticket = json.loads(urllib.request.urlopen(req).read())["ticket"]
async def main():
    async with websockets.connect(f"ws://127.0.0.1:{port}/api/ws?ticket={ticket}", max_size=None) as ws:
        await ws.recv()
        for i, (m, p) in enumerate(calls, 1):
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": i, "method": m, "params": p}))
            while True:
                f = json.loads(await ws.recv())
                if f.get("id") == i: break
            print(m, "->", json.dumps(f.get("result", f.get("error")))[:220])
asyncio.run(main())
PY
}
ADMIN_CODE=$("$ROOT/venv/bin/hexbot" pair 2>/dev/null | grep -oE '[A-Z2-9]{4}-[A-Z2-9]{4}' | head -1)
ADMIN=$(login "$ADMIN_CODE" "admin-mac"); [ -n "$ADMIN" ] && echo "PASS admin paired" || { echo "FAIL admin pairing"; exit 1; }
rpc "$ADMIN" '[["hexbot.users.me",{}],["hexbot.bots.create",{"name":"scout","provider":"openai-codex","model":"gpt-5.6-sol"}]]'
INVITE=$(rpc "$ADMIN" '[["hexbot.users.invite",{"display_name":"Sam","role":"member"}]]'); echo "$INVITE"
CODE=$(echo "$INVITE" | grep -oE '[A-Z2-9]{4}-[A-Z2-9]{4}' | head -1)
MEMBER=$(login "$CODE" "sams-laptop"); [ -n "$MEMBER" ] && echo "PASS member paired with invite code" || { echo "FAIL member pairing"; exit 1; }
rpc "$MEMBER" '[["hexbot.users.me",{}],["hexbot.bots.list",{}],["hexbot.providers.set_key",{"provider":"openai","key":"x"}],["hexbot.bots.create",{"name":"helper","provider":"openai-codex","model":"gpt-5.6-sol"}],["hexbot.bots.list",{}]]'
rpc "$ADMIN" '[["hexbot.bots.list",{}],["hexbot.bots.list",{"all":true}],["hexbot.users.list",{}]]'
