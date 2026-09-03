"""Hermes dashboard auth backed by Hexbot device tokens."""

from __future__ import annotations

import time

import jwt

from hermes_cli.dashboard_auth import (
    DashboardAuthProvider, InvalidCredentialsError, LoginStart,
    RefreshExpiredError, Session,
)

from hexbot.errors import HexbotError
from hexbot.connect import ConnectConfig
from hexbot.pairing import DeviceRow, mint_device, redeem_code, verify_token

SESSION_TTL_SECONDS = 10 * 365 * 24 * 60 * 60


class HexbotAuthProvider(DashboardAuthProvider):
    name = "hexbot"
    display_name = "Hexbot pairing"
    supports_password = True
    supports_session = True
    supports_token = False

    def __init__(self, jwks_fetcher=None):
        self._jwks_fetcher = jwks_fetcher
        self._jwks_cache: dict[str, dict] = {}

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

    def _fetch_jwks(self, url: str) -> dict:
        if self._jwks_fetcher is not None:
            value = self._jwks_fetcher(url)
        else:
            import httpx
            response = httpx.get(url, timeout=15)
            response.raise_for_status()
            value = response.json()
        if not isinstance(value, dict) or not isinstance(value.get("keys"), list):
            raise ValueError("invalid JWKS")
        return value

    @staticmethod
    def _key_for(jwks: dict, kid: str):
        for value in jwks.get("keys", []):
            if value.get("kid") == kid:
                return jwt.PyJWK.from_dict(value).key
        return None

    def _connect_login(self, token: str) -> Session:
        try:
            config = ConnectConfig.load()
            if config is None or not config.daemon_id:
                raise ValueError("Connect is not configured")
            header = jwt.get_unverified_header(token)
            if header.get("alg") != "ES256" or not isinstance(header.get("kid"), str):
                raise ValueError("unsupported grant header")
            jwks = self._jwks_cache.get(config.jwks_url)
            if jwks is None:
                jwks = self._fetch_jwks(config.jwks_url)
                self._jwks_cache[config.jwks_url] = jwks
            key = self._key_for(jwks, header["kid"])
            if key is None:
                jwks = self._fetch_jwks(config.jwks_url)
                self._jwks_cache[config.jwks_url] = jwks
                key = self._key_for(jwks, header["kid"])
            if key is None:
                raise ValueError("unknown signing key")
            claims = jwt.decode(token, key, algorithms=["ES256"], options={
                "require": ["sub", "daemon_id", "device_name", "exp", "iat"]})
            if claims["daemon_id"] != config.daemon_id:
                raise ValueError("wrong daemon")
            name = str(claims["device_name"]).strip()[:80]
            if not name:
                raise ValueError("empty device name")
            device = mint_device(name, "connect")
            return self._session(device, device.token)
        except Exception as exc:
            raise InvalidCredentialsError("invalid Connect grant") from exc

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
