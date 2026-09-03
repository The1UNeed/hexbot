"""Shared fixtures. Every test runs against a throwaway HEXBOT_HOME."""

import pytest


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    """Point HEXBOT_HOME (and therefore HERMES_HOME) at a temp dir.

    ``~/.hexbot`` and ``~/.hermes`` must never be touched by the suite, so this
    is autouse and also clears the process-global live-session map that
    ``hexbot.sections`` keeps.
    """
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HEXBOT_HOME", str(home))
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HEXBOT_WORKSPACE", str(tmp_path / "workspace"))
    from hexbot.sections import _LIVE
    _LIVE.clear()
    from hexbot.activity import _DELIVERY_LOCKS, _HOPS, _SESSION_ORIGINS
    _HOPS.clear()
    _SESSION_ORIGINS.clear()
    _DELIVERY_LOCKS.clear()
    import hexbot.rooms.engine as room_engine
    previous_engine = room_engine._ENGINE
    room_engine._ENGINE = None
    yield home
    _LIVE.clear()
    _HOPS.clear()
    _SESSION_ORIGINS.clear()
    _DELIVERY_LOCKS.clear()
    current_engine = room_engine._ENGINE
    if current_engine is not None and current_engine is not previous_engine:
        current_engine.close()
    room_engine._ENGINE = previous_engine


@pytest.fixture
def fake_gateway(monkeypatch):
    """A dict-driven stand-in for ``hexbot.gateway.call``.

    Records every ``(method, params)`` pair and answers from ``responses``,
    which maps a method name to a dict or to a callable taking ``params``. A
    callable may raise ``GatewayError`` to exercise a Hermes error path.
    """
    class Fake:
        def __init__(self):
            self.calls: list[tuple[str, dict]] = []
            self.responses: dict = {}
            self.events: list[tuple[str, dict]] = []

        def __call__(self, method, params, rid=None):
            self.calls.append((method, dict(params)))
            answer = self.responses.get(method, {})
            return answer(params) if callable(answer) else answer

        def params_for(self, method):
            return [params for name, params in self.calls if name == method]

        def methods(self):
            return [name for name, _ in self.calls]

    fake = Fake()
    monkeypatch.setattr("hexbot.gateway.call", fake)
    monkeypatch.setattr("hexbot.gateway.broadcast",
                        lambda event, payload: fake.events.append((event, payload)))
    return fake
