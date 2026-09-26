import json
import stat
import threading
import time
from pathlib import Path

import pytest
from ruamel.yaml import YAML


def approved(**extra):
    return {"status": "approved", "daemon_id": "daemon-1", "daemon_token": "secret",
            "slug": "kitchen", "tunnel_hostname": "kitchen.connect.hexbot.app",
            "tunnel_token": "tunnel", **extra}


def test_config_round_trip_permissions_and_clear(isolated_home):
    from hexbot.connect import ConnectConfig

    config = ConnectConfig(api_base="https://example.test/", daemon_id="daemon-1",
                           daemon_token="secret", slug="kitchen")
    config.save()
    assert ConnectConfig.load() == config
    assert stat.S_IMODE((isolated_home / "connect.json").stat().st_mode) == 0o600
    assert config.jwks_url == "https://example.test/.well-known/jwks.json"
    ConnectConfig.clear()
    assert ConnectConfig.load() is None


@pytest.mark.parametrize(("reply", "code"), [
    ({"status": "expired"}, 4241), ({"status": "denied"}, 4242),
])
def test_registration_terminal_failures(reply, code):
    from hexbot.connect import register
    from hexbot.errors import HexbotError

    class Client:
        api_base = "https://example.test"
        def register_start(self, *_args, **_kwargs):
            return {"device_code": "device", "user_code": "ABCD1234",
                    "verify_url": "https://example.test/approve", "interval": 0}
        def register_poll(self, _code): return reply

    with pytest.raises(HexbotError) as caught:
        register("Kitchen", client=Client(), sleep=lambda _seconds: None, out=lambda _line: None)
    assert caught.value.code == code


def test_registration_approved_saves_and_prints(isolated_home):
    from hexbot.connect import ConnectConfig, register

    class Client:
        api_base = "https://example.test"
        replies = iter(({"status": "pending"}, approved()))
        def register_start(self, *_args, **_kwargs):
            return {"device_code": "device", "user_code": "ABCD1234",
                    "verify_url": "https://example.test/approve", "interval": 2}
        def register_poll(self, _code): return next(self.replies)

    output, sleeps = [], []
    config = register("Kitchen", client=Client(), sleep=sleeps.append, out=output.append)
    assert config == ConnectConfig.load()
    assert sleeps == [2]
    assert output == ["Open: https://example.test/approve", "Code: ABCD1234"]
    assert "https://kitchen.connect.hexbot.app" in (isolated_home / "config.yaml").read_text()


def test_public_url_is_mirrored_and_removed_without_losing_keys(isolated_home):
    from hexbot.connect import apply_public_url

    targets = [isolated_home / "config.yaml", isolated_home / "profiles/scout/config.yaml"]
    for path in targets:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("model: keep\ndashboard:\n  theme: dark\n")
    apply_public_url("kitchen.connect.hexbot.app")
    yaml = YAML(typ="safe")
    for path in targets:
        data = yaml.load(path.read_text())
        assert data["model"] == "keep" and data["dashboard"]["theme"] == "dark"
        assert data["dashboard"]["public_url"] == "https://kitchen.connect.hexbot.app"
    apply_public_url(None)
    for path in targets:
        data = yaml.load(path.read_text())
        assert data == {"model": "keep", "dashboard": {"theme": "dark"}}


def test_tunnel_supervisor_restarts_with_backoff_and_stops(isolated_home):
    from hexbot.connect import ConnectConfig, Tunnel

    binary = isolated_home / "bin/cloudflared"
    binary.parent.mkdir()
    binary.write_text("fake")
    binary.chmod(0o700)
    sleeps, commands, release = [], [], threading.Event()

    class Child:
        def __init__(self, number): self.number, self.terminated = number, False
        def wait(self):
            if self.number >= 4: release.wait(1)
            return 1
        def poll(self): return None if self.number >= 4 and not self.terminated else 1
        def terminate(self): self.terminated = True; release.set()

    def spawn(command, **_kwargs):
        commands.append(command)
        return Child(len(commands))

    tunnel = Tunnel(ConnectConfig(tunnel_token="token"), spawn=spawn,
                    sleep=lambda seconds: sleeps.append(seconds))
    tunnel.start(9119)
    deadline = time.time() + 1
    while len(commands) < 4 and time.time() < deadline:
        time.sleep(0.005)
    tunnel.stop()
    assert sleeps[:3] == [1, 2, 4]
    assert commands[0][-4:] == ["tunnel", "run", "--token", "token"]
    assert not tunnel.running


def test_connect_rpc_methods_and_frames(monkeypatch):
    from hexbot import rpc

    class Client:
        api_base = "https://example.test"
        def register_start(self, name, system):
            return {"device_code": "d", "user_code": "u", "verify_url": "v", "interval": 1}
        def register_poll(self, code): return {"status": "pending"}

    monkeypatch.setattr("hexbot.connect.ConnectClient", Client)
    assert rpc.METHODS["hexbot.connect.register_start"]({})["device_code"] == "d"
    assert rpc.METHODS["hexbot.connect.register_poll"]({"device_code": "d"}) == {"status": "pending"}

    class Context:
        def __init__(self): self.methods = {}
        def register_rpc_method(self, name, fn): self.methods[name] = fn

    context = Context()
    rpc.register(context)
    frame = context.methods["hexbot.connect.status"]("request-1", {})
    assert frame["id"] == "request-1" and "result" in frame


def test_api_base_defaults_and_env_override(monkeypatch):
    from hexbot import connect

    monkeypatch.delenv("HEXBOT_CONNECT_URL", raising=False)
    assert connect.ConnectClient().api_base == "https://connect.hexbot.app"
    monkeypatch.setenv("HEXBOT_CONNECT_URL", "http://localhost:3000/")
    assert connect.ConnectClient().api_base == "http://localhost:3000"
    assert connect.ConnectConfig().jwks_url == "http://localhost:3000/.well-known/jwks.json"


def test_disconnect_revokes_remotely_and_clears(isolated_home):
    from hexbot import connect

    connect.ConnectConfig(daemon_id="daemon-1", daemon_token="secret", slug="kitchen").save()
    calls = []

    class Client:
        def revoke(self, daemon_id, token): calls.append((daemon_id, token)); return {"ok": True}

    assert connect.disconnect(client=Client())["registered"] is False
    assert calls == [("daemon-1", "secret")] and connect.ConnectConfig.load() is None


def test_disconnect_survives_unreachable_service(isolated_home):
    from hexbot import connect

    connect.ConnectConfig(daemon_id="daemon-1", daemon_token="secret", slug="kitchen").save()

    class Client:
        def revoke(self, *_args): raise RuntimeError("offline")

    assert connect.disconnect(client=Client())["registered"] is False
    assert connect.ConnectConfig.load() is None


def test_restarting_workers_stops_the_previous_heartbeat(isolated_home):
    import threading
    from hexbot import connect

    connect.ConnectConfig(daemon_id="daemon-1", daemon_token="secret", slug="kitchen",
                          tunnel_hostname="kitchen.hexbot.test").save()
    ports = []
    release = threading.Event()

    class Client:
        def heartbeat(self, _id, _token, port):
            ports.append(port)
            release.wait(2)  # a slow request in flight while the workers are restarted
            return {"ok": True}

    class NoTunnel:
        running = False
        def start(self, port): pass
        def stop(self): pass

    from hermes_cli.dashboard_auth.registry import clear_providers
    try:
        assert connect.start_daemon(9001, client=Client(), tunnel=NoTunnel())
        assert connect.start_daemon(9002, client=Client(), tunnel=NoTunnel())
    finally:
        release.set()
        connect.stop_daemon()
        clear_providers()
    assert ports == [9001, 9002]
    assert connect.status()["last_heartbeat_at"] is None or ports[-1] == 9002


def test_start_daemon_registers_connect_sign_in_and_disconnect_removes_it(isolated_home):
    from hermes_cli.dashboard_auth.registry import clear_providers, list_providers
    from hexbot import connect

    connect.ConnectConfig(daemon_id="daemon-1", daemon_token="secret", slug="kitchen").save()

    class Client:
        def heartbeat(self, *_args): return {"ok": True}
        def revoke(self, *_args): return {"ok": True}

    class NoTunnel:
        running = False
        def start(self, port): pass
        def stop(self): pass

    clear_providers()
    try:
        assert connect.start_daemon(9001, client=Client(), tunnel=NoTunnel())
        assert [p.name for p in list_providers()] == ["connect"]
        assert connect.disconnect(client=Client())["registered"] is False
        assert list_providers() == []
    finally:
        connect.stop_daemon()
        clear_providers()


def test_cli_connect_uses_name_and_short_circuits_when_registered(monkeypatch, capsys):
    from hexbot import cli, connect

    names = []
    config = connect.ConnectConfig(api_base="https://example.test", daemon_id="daemon-1",
                                   tunnel_hostname="kitchen.connect.hexbot.app")
    monkeypatch.setattr(connect, "register", lambda name, *, client: names.append(name) or config)
    monkeypatch.setattr(connect, "status", lambda: {"registered": False, "tunnel_hostname": None})
    assert cli.main(["connect", "--name", "Kitchen"]) == 0
    assert names == ["Kitchen"]
    assert capsys.readouterr().out.splitlines() == [
        "Connected: https://kitchen.connect.hexbot.app",
        "Open it in a browser: https://kitchen.connect.hexbot.app",
        "Manage daemons: https://example.test/connect",
    ]
    monkeypatch.setattr(connect, "status",
                        lambda: {"registered": True, "tunnel_hostname": "kitchen.connect.hexbot.app"})
    assert cli.main(["connect"]) == 0
    assert names == ["Kitchen"]
    assert capsys.readouterr().out.splitlines() == [
        "Already connected: https://kitchen.connect.hexbot.app",
        "Run `hexbot connect disconnect` first to register again.",
    ]
