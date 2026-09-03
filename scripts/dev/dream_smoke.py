#!/usr/bin/env python3
"""Exercise Hexbot dreaming against a running daemon."""

from __future__ import annotations

import argparse
import json
import time

from websockets.sync.client import connect


class Rpc:
    def __init__(self, socket):
        self.socket, self.next_id = socket, 1

    def call(self, method, params=None):
        rid = self.next_id
        self.next_id += 1
        self.socket.send(json.dumps({"jsonrpc": "2.0", "id": rid,
                                     "method": method, "params": params or {}}))
        while True:
            frame = json.loads(self.socket.recv())
            if frame.get("id") != rid:
                continue
            if "error" in frame:
                raise RuntimeError(f"{method}: {frame['error']}")
            return frame["result"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="ws://127.0.0.1:9119/api/ws")
    parser.add_argument("--token", help="daemon bearer token")
    args = parser.parse_args()
    url = args.url + (("&" if "?" in args.url else "?") + "token=" + args.token
                      if args.token else "")
    name = f"dream-smoke-{int(time.time())}"
    with connect(url, open_timeout=10) as socket:
        rpc = Rpc(socket)
        created = rpc.call("hexbot.bots.create", {
            "name": name, "display_name": "Dream Smoke", "provider": "openai-codex",
            "model": "gpt-5.6-sol"})
        section = created["section"]
        opened = rpc.call("hexbot.sections.open", {"id": section["id"]})
        live = opened["section"]["live_session_id"]
        rpc.call("prompt.submit", {"session_id": live,
                                    "text": "Remember that my test color is indigo."})
        rpc.call("prompt.submit", {"session_id": live,
                                    "text": "I still need to finish the smoke-test report."})
        rpc.call("hexbot.dreaming.run_now", {"bot": name})
        deadline = time.monotonic() + 180
        dreams = []
        while time.monotonic() < deadline:
            dreams = rpc.call("hexbot.dreaming.list", {"bot": name, "limit": 1})["dreams"]
            if dreams and dreams[0]["status"] != "running":
                break
            time.sleep(2)
        if not dreams:
            raise SystemExit("dream did not finish within 3 minutes")
        print("MEMORY.md")
        print(rpc.call("hexbot.memory.bot.get", {"bot": name})["memory_md"])
        dream_section = next(item for item in rpc.call(
            "hexbot.sections.list", {"bot": name, "include_archived": True})["sections"]
                             if item["title"] == "Dreams")
        print("\nDreams section")
        print(json.dumps(rpc.call("hexbot.sections.open", {"id": dream_section["id"]})["messages"],
                         ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
