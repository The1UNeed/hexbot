"""Call JSON-RPC methods on a loopback daemon. Usage:
  HEXBOT_HOME=<home> uv run --no-project --with websockets python scripts/dev/rpc.py <port> '<json list of [method, params]>'
The daemon never puts its token in a page; read it from the home's private token file.
Placeholders "$name" in params are replaced from earlier results carrying that key."""
import asyncio, json, os, sys
import websockets

PORT = int(sys.argv[1]); calls = json.loads(sys.argv[2])
HOME = os.environ.get("HEXBOT_HOME") or sys.exit("Set HEXBOT_HOME to the daemon's home (never ~/.hexbot for a dev daemon)")
tok = open(os.path.join(HOME, "local-device.token")).read().strip()

async def main():
    async with websockets.connect(f"ws://127.0.0.1:{PORT}/api/ws?token={tok}", max_size=None) as ws:
        await ws.recv()
        ctx, rid = {}, 0
        for method, params in calls:
            rid += 1
            params = {k: (ctx.get(v[1:], v) if isinstance(v, str) and v.startswith("$") else v) for k, v in params.items()}
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}))
            while True:
                frame = json.loads(await ws.recv())
                if frame.get("id") == rid:
                    break
            out = frame.get("result", frame.get("error"))
            print(f"{method} -> {json.dumps(out)[:int(sys.argv[3]) if len(sys.argv) > 3 else 400]}")
            if isinstance(out, dict):
                for key in ("bot", "section", "room"):
                    if isinstance(out.get(key), dict):
                        ctx[key + "_id"] = out[key].get("id") or out[key].get("name")
                if "rooms" in out and out["rooms"]:
                    ctx["room_id"] = out["rooms"][0]["id"]
asyncio.run(main())
