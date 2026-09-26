"""Hermes dashboard auth backed by Hexbot device tokens."""

from __future__ import annotations

import base64
import hashlib
import logging
import secrets
import sqlite3
import threading
import time
import urllib.parse

from hermes_cli.dashboard_auth import (
    DashboardAuthProvider, InvalidCodeError, InvalidCredentialsError, LoginStart,
    ProviderError, RefreshExpiredError, Session,
)

from hexbot import db
from hexbot.errors import HexbotError
from hexbot.connect import ConnectClient, ConnectConfig, verify_grant
from hexbot.pairing import DeviceRow, mint_device, redeem_code, verify_token

logger = logging.getLogger(__name__)
SESSION_TTL_SECONDS = 10 * 365 * 24 * 60 * 60
GRANT_LEEWAY_SECONDS = 60  # a daemon clock a little behind Connect's must not reject every grant
_USED_GRANTS_LOCK = threading.Lock()


def _mark_grant_used(jti: str, exp: float) -> None:
    """Record a grant as spent, in the database so a restart within its lifetime cannot replay it."""
    now = time.time()
    db.migrate()
    with _USED_GRANTS_LOCK, db.transaction() as conn:
        conn.execute("DELETE FROM spent_grants WHERE exp <= ?", (now - GRANT_LEEWAY_SECONDS,))
        try:
            conn.execute("INSERT INTO spent_grants(jti, exp) VALUES (?, ?)", (jti, exp))
        except sqlite3.IntegrityError as exc:
            raise ValueError("grant already used") from exc


class _DeviceSessionProvider(DashboardAuthProvider):
    """Device-token sessions plus Connect grant verification, shared by both providers."""

    def _verify_grant(self, token: str) -> dict:
        """Claims of a valid, unused Connect grant for this daemon. Raises on anything else."""
        try:
            claims = verify_grant(token)
        except Exception as exc:
            logger.warning("Connect grant rejected: %s", exc)
            raise
        _mark_grant_used(str(claims["jti"]), float(claims["exp"]))
        return claims

    def _grant_session(self, token: str) -> Session:
        claims = self._verify_grant(token)
        name = str(claims["device_name"]).strip()[:80]
        if not name:
            raise ValueError("empty device name")
        device = mint_device(name, "connect")  # admin: the sidecar accepts only the pinned owner
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


class HexbotAuthProvider(_DeviceSessionProvider):
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
        if password.startswith("cg_"):
            return self._connect_login(password[3:])
        device_name = username.strip()[:80] or "Unnamed device"
        try:
            device = redeem_code(password, device_name=device_name, platform="browser")
        except HexbotError as exc:
            if exc.code in {4231, 4232}:
                raise InvalidCredentialsError("invalid pairing code") from exc
            raise
        return self._session(device, device.token)

    def _connect_login(self, token: str) -> Session:
        try:
            return self._grant_session(token)
        except Exception as exc:
            raise InvalidCredentialsError("invalid Connect grant") from exc


class HexConnectProvider(_DeviceSessionProvider):
    """Browser sign-in through Hex Connect: PKCE to the broker, a grant back."""

    name = "connect"
    display_name = "Hex Connect"
    supports_password = False
    supports_session = True
    supports_token = False

    def __init__(self, http=None):
        self._http = http

    @staticmethod
    def _config() -> ConnectConfig:
        config = ConnectConfig.load()
        if config is None or not config.daemon_id:
            raise ProviderError("Hex Connect is not set up on this daemon")
        return config

    def start_login(self, *, redirect_uri: str) -> LoginStart:
        config = self._config()
        state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(48)
        digest = hashlib.sha256(verifier.encode("ascii")).digest()
        challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
        query = urllib.parse.urlencode({"daemon": config.daemon_id, "state": state,
                                        "code_challenge": challenge, "redirect_uri": redirect_uri})
        return LoginStart(redirect_url=f"{config.api_base}/connect/browser?{query}",
                          cookie_payload={"hermes_session_pkce": f"state={state};verifier={verifier}"})

    def complete_login(
        self, *, code: str, state: str, code_verifier: str, redirect_uri: str
    ) -> Session:
        config = self._config()
        try:
            result = ConnectClient(config.api_base, http=self._http).exchange_grant(
                config.daemon_id, config.daemon_token, code=code,
                code_verifier=code_verifier, redirect_uri=redirect_uri)
        except HexbotError as exc:
            if exc.code == 4243:
                raise InvalidCodeError("Connect sign-in code rejected") from exc
            raise ProviderError(str(exc)) from exc
        try:
            return self._grant_session(result["grant"])
        except Exception as exc:
            raise InvalidCodeError("invalid Connect grant") from exc
