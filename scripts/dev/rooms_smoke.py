#!/usr/bin/env python3
"""Exercise a two-bot room against a running local Hexbot daemon."""

from __future__ import annotations

import argparse
import json
import time

from websockets.sync.client import connect


class Rpc:
    def __init__(self, socket):
        self.socket, self.next_id = socket, 1

    def call(self, method, params=None):
        rid = self.next_id; self.next_id += 1
        self.socket.send(json.dumps({"jsonrpc": "2.0", "id": rid,
                                     "method": method, "params": params or {}}))
        while True:
            frame = json.loads(self.socket.recv())
            if frame.get("id") != rid:
                continue
            if "error" in frame:
                raise RuntimeError(f"{method}: {frame['error']}")
            return frame["result"]


def ensure_bot(rpc, name, title):
    try:
        return rpc.call("hexbot.bots.get", {"name": name})["bot"]
    except RuntimeError:
        return rpc.call("hexbot.bots.create", {
            "name": name, "display_name": name.title(), "title": title,
            "provider": "openai-codex", "model": "gpt-5.6-sol"})["bot"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="ws://127.0.0.1:9119/api/ws")
    parser.add_argument("--token", help="daemon bearer token")
    args = parser.parse_args()
    url = args.url + (("&" if "?" in args.url else "?") + "token=" + args.token
                      if args.token else "")
    with connect(url, open_timeout=10) as socket:
        rpc = Rpc(socket)
        ensure_bot(rpc, "scout", "Research scout")
        ensure_bot(rpc, "writer", "Slogan writer")
        room = rpc.call("hexbot.rooms.create", {
            "name": f"Rooms smoke {int(time.time())}",
            "members": ["scout", "writer"], "main_bot": "scout"})["room"]
        rpc.call("hexbot.rooms.send", {"id": room["id"], "text":
                 "Scout, ask @writer for a one-line slogan and then summarise"})
        seen, deadline, quiet_since = 0, time.monotonic() + 180, None
        while time.monotonic() < deadline:
            events = rpc.call("hexbot.rooms.log", {
                "id": room["id"], "after_seq": seen, "limit": 200})["events"]
            for event in events:
                seen = max(seen, event["seq"])
                print(json.dumps(event, ensure_ascii=False), flush=True)
            if events:
                quiet_since = time.monotonic()
            elif quiet_since and time.monotonic() - quiet_since >= 5:
                return
            time.sleep(1)
        raise SystemExit("room engine did not idle within 3 minutes")


if __name__ == "__main__":
    main()
