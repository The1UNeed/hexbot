"""Hermes dashboard auth backed by Hexbot device tokens."""

from __future__ import annotations

import time

from hermes_cli.dashboard_auth import (
    DashboardAuthProvider, InvalidCredentialsError, LoginStart,
    RefreshExpiredError, Session,
)

from hexbot.errors import HexbotError
from hexbot.pairing import DeviceRow, redeem_code, verify_token

SESSION_TTL_SECONDS = 10 * 365 * 24 * 60 * 60


class HexbotAuthProvider(DashboardAuthProvider):
    name = "hexbot"
    display_name = "Hexbot pairing"
    supports_password = True
    supports_session = True
    supports_token = False

    def start_login(self, *, redirect_uri: str) -> LoginStart:
        raise NotImplementedError("Hexbot pairing uses password login")

    def complete_login(
        self, *, code: str, state: str, code_verifier: str, redirect_uri: str
    ) -> Session:
        raise NotImplementedError("Hexbot pairing uses password login")

    def complete_password_login(self, *, username: str, password: str) -> Session:
        device_name = username.strip()[:80] or "Unnamed device"
        try:
            device = redeem_code(password, device_name=device_name, platform="browser")
        except HexbotError as exc:
            if exc.code in {4231, 4232}:
                raise InvalidCredentialsError("invalid pairing code") from exc
            raise
        return self._session(device, device.token)

    def verify_session(self, *, access_token: str) -> Session | None:
        device = verify_token(access_token)
        return self._session(device, access_token) if device else None

    def refresh_session(self, *, refresh_token: str) -> Session:
        raise RefreshExpiredError("Hexbot device sessions do not refresh")

    def revoke_session(self, *, refresh_token: str) -> None:
        return None

    def _session(self, device: DeviceRow, token: str) -> Session:
        return Session(
            user_id=f"device:{device.id}", email="", display_name=device.name,
            org_id="", provider=self.name, expires_at=int(time.time()) + SESSION_TTL_SECONDS,
            access_token=token, refresh_token="",
        )
