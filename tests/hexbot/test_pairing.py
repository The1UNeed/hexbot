import os
import re
import time

import pytest


def test_code_format_normalization_and_link():
    from hexbot.pairing import new_code, normalize_code, pair_link

    code = new_code()
    assert re.fullmatch(r"[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}", code)
    assert normalize_code(f"  {code.lower().replace('-', ' - ')} ") == code.replace("-", "")
    assert pair_link("192.168.1.8", 9119, code) == (
        f"hexbot://pair?host=192.168.1.8&port=9119#code={code}")


def test_code_is_single_use_and_new_code_invalidates_old():
    from hexbot.errors import HexbotError
    from hexbot.pairing import new_code, redeem_code

    old = new_code()
    current = new_code()
    with pytest.raises(HexbotError, match="invalid or expired"):
        redeem_code(old, device_name="old", platform="browser")
    device = redeem_code(current, device_name="phone", platform="ios")
    assert device.token.startswith("hxb_")
    with pytest.raises(HexbotError, match="invalid or expired"):
        redeem_code(current, device_name="again", platform="ios")


def test_expired_code(monkeypatch):
    from hexbot.errors import HexbotError
    from hexbot import pairing

    monkeypatch.setattr(pairing.time, "time", lambda: 1000)
    code = pairing.new_code()
    monkeypatch.setattr(pairing.time, "time", lambda: 1601)
    with pytest.raises(HexbotError) as caught:
        pairing.redeem_code(code, device_name="late", platform="browser")
    assert caught.value.code == 4231


def test_failed_attempt_rate_limit():
    from hexbot.errors import HexbotError
    from hexbot import pairing

    pairing._FAILED_ATTEMPTS.clear()
    for _ in range(10):
        with pytest.raises(HexbotError) as caught:
            pairing.redeem_code("BAD", device_name="x", platform="browser")
        assert caught.value.code == 4231
    with pytest.raises(HexbotError) as caught:
        pairing.redeem_code("BAD", device_name="x", platform="browser")
    assert caught.value.code == 4232
    pairing._FAILED_ATTEMPTS.clear()


def test_verify_touch_and_revoke(monkeypatch):
    from hexbot import pairing

    monkeypatch.setattr(pairing.time, "time", lambda: 1000)
    device = pairing.redeem_code(pairing.new_code(), device_name="laptop", platform="linux")
    assert pairing.verify_token(device.token).id == device.id
    monkeypatch.setattr(pairing.time, "time", lambda: 1059)
    assert pairing.verify_token(device.token).last_seen_at == 1000
    monkeypatch.setattr(pairing.time, "time", lambda: 1060)
    assert pairing.verify_token(device.token).last_seen_at == 1060
    assert pairing.revoke_device(device.id) is True
    assert pairing.verify_token(device.token) is None


def test_local_device_reuse_and_missing_file_rotation(isolated_home):
    from hexbot.pairing import local_device

    first, token = local_device()
    path = isolated_home / "local-device.token"
    assert path.read_text().strip() == token
    assert path.stat().st_mode & 0o777 == 0o600
    again, again_token = local_device()
    assert (again.id, again_token) == (first.id, token)
    path.unlink()
    rotated, rotated_token = local_device()
    assert rotated.id != first.id and rotated_token != token
