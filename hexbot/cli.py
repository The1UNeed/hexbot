"""Command-line entry point for Hexbot."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def _set_home() -> None:
    home = str(Path(os.environ.get("HEXBOT_HOME", "~/.hexbot")).expanduser())
    os.environ["HEXBOT_HOME"] = home
    os.environ["HERMES_HOME"] = home


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="hexbot")
    sub = root.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve")
    serve.add_argument("--host"); serve.add_argument("--port", type=int)
    lan = serve.add_mutually_exclusive_group()
    lan.add_argument("--lan", action="store_true", dest="lan")
    lan.add_argument("--no-lan", action="store_false", dest="lan")
    serve.set_defaults(lan=None)
    sub.add_parser("pair")
    devices = sub.add_parser("devices").add_subparsers(dest="devices_command", required=True)
    devices.add_parser("list")
    revoke = devices.add_parser("revoke"); revoke.add_argument("id")
    bots = sub.add_parser("bots").add_subparsers(dest="bots_command", required=True)
    bots.add_parser("list")
    create = bots.add_parser("create"); create.add_argument("name")
    for flag in ("title", "description", "persona", "provider", "model"):
        create.add_argument(f"--{flag}")
    delete = bots.add_parser("delete"); delete.add_argument("name")
    send = sub.add_parser("send"); send.add_argument("bot"); send.add_argument("text")
    passthrough = sub.add_parser("hermes"); passthrough.add_argument("args", nargs=argparse.REMAINDER)
    sub.add_parser("version")
    return root


def main(argv=None):
    _set_home()
    args = parser().parse_args(argv)
    if args.command == "serve":
        from hexbot.serve import run
        return run(args.host, args.port, args.lan)
    if args.command == "version":
        from hexbot import __version__
        print(__version__); return 0
    if args.command == "pair":
        from hexbot import network, pairing
        code = pairing.new_code()
        net = network.get_network()
        addresses = net["addresses"] or [net["bind_host"]]
        link = pairing.pair_link(addresses[0], net["port"], code)
        print(f"Pairing code: {code}")
        print(f"Expires in: 10 minutes")
        endpoints = ", ".join(f"{address}:{net['port']}" for address in addresses)
        print(f"Addresses: {endpoints}")
        print(f"Link: {link}")
        try:
            import segno
            segno.make(link).terminal(compact=True)
        except ImportError:
            print("QR unavailable: install segno 1.6.6")
        return 0
    if args.command == "devices":
        from hexbot import pairing
        if args.devices_command == "list":
            rows = [{"id": row.id, "name": row.name, "platform": row.platform,
                     "created_at": row.created_at, "last_seen_at": row.last_seen_at}
                    for row in pairing.list_devices()]
            print(json.dumps({"devices": rows}, indent=2)); return 0
        print(json.dumps({"revoked": pairing.revoke_device(args.id)})); return 0
    if args.command == "send":
        executable = Path(sys.executable).with_name("hermes")
        result = subprocess.run([str(executable), "-p", args.bot, "chat", "-q", args.text,
                                 "--oneshot", "-Q"], env=os.environ.copy(), text=True)
        return result.returncode
    if args.command == "hermes":
        from hermes_cli.main import main as hermes_main
        old = sys.argv
        try: sys.argv = ["hermes", *args.args]; return hermes_main()
        finally: sys.argv = old
    from hexbot import bots
    if args.bots_command == "list":
        print(json.dumps({"bots": bots.list_bots()}, indent=2)); return 0
    if args.bots_command == "create":
        kwargs = {key: getattr(args, key) for key in ("title", "description", "persona", "provider", "model")}
        bot, section = bots.create_bot(args.name, **kwargs)
        print(json.dumps({"bot": bot, "section": section}, indent=2)); return 0
    print(json.dumps({"deleted": bots.delete_bot(args.name)})); return 0


if __name__ == "__main__":
    raise SystemExit(main())
