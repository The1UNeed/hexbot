"""Browser sign-in for subscription providers, driven from the desktop app.

The device-code flows Hexbot runs interactively in a terminal are run here in
a background thread so a client can start one, show the user the URL and code,
and poll until the grant is stored in the Hexbot auth store.

Supported: ``openai-codex`` (ChatGPT or Codex subscription), ``xai-oauth``
(SuperGrok / Premium+), ``nous`` (Nous Portal). Other OAuth providers report
``supported: false`` with the CLI command to use instead.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import dataclass, field

from hexbot.errors import HexbotError

logger = logging.getLogger(__name__)

TIMEOUT_SECONDS = 15 * 60


@dataclass
class Login:
    id: str
    provider: str
    url: str = ""
    code: str = ""
    status: str = "starting"  # starting | pending | done | error | cancelled
    message: str = ""
    started: float = field(default_factory=time.monotonic)
    cancel: threading.Event = field(default_factory=threading.Event)
    ready: threading.Event = field(default_factory=threading.Event)

    def public(self) -> dict:
        return {"login_id": self.id, "provider": self.provider, "status": self.status,
                "url": self.url, "code": self.code, "message": self.message}


_logins: dict[str, Login] = {}
_lock = threading.Lock()


def _codex_flow(login: Login) -> None:
    import httpx
    from hermes_cli import auth

    issuer = "https://auth.openai.com"
    with auth._codex_http_client(timeout=httpx.Timeout(15.0)) as client:
        resp = client.post(f"{issuer}/api/accounts/deviceauth/usercode",
                           json={"client_id": auth.CODEX_OAUTH_CLIENT_ID},
                           headers={"Content-Type": "application/json"})
        if resp.status_code == 429:
            raise HexbotError(4211, "OpenAI is rate-limiting sign-in requests. Wait a minute and try again.")
        if resp.status_code != 200:
            raise HexbotError(4211, f"OpenAI device code request failed (HTTP {resp.status_code}).")
        data = resp.json()
        user_code, device_auth_id = data.get("user_code", ""), data.get("device_auth_id", "")
        if not user_code or not device_auth_id:
            raise HexbotError(4211, "OpenAI device code response was incomplete.")
        interval = max(3, int(data.get("interval", "5")))
        login.url, login.code, login.status = f"{issuer}/codex/device", user_code, "pending"
        login.ready.set()
        code_resp = None
        while time.monotonic() - login.started < TIMEOUT_SECONDS and not login.cancel.is_set():
            if login.cancel.wait(interval):
                break
            poll = client.post(f"{issuer}/api/accounts/deviceauth/token",
                               json={"device_auth_id": device_auth_id, "user_code": user_code},
                               headers={"Content-Type": "application/json"})
            if poll.status_code == 200:
                code_resp = poll.json()
                break
            if poll.status_code not in (403, 404):
                raise HexbotError(4211, f"OpenAI sign-in polling failed (HTTP {poll.status_code}).")
        if login.cancel.is_set():
            return
        if code_resp is None:
            raise HexbotError(4211, "Sign-in timed out. Start it again when you are ready.")
        token_resp = client.post(auth.CODEX_OAUTH_TOKEN_URL, data={
            "grant_type": "authorization_code",
            "code": code_resp.get("authorization_code", ""),
            "redirect_uri": f"{issuer}/deviceauth/callback",
            "client_id": auth.CODEX_OAUTH_CLIENT_ID,
            "code_verifier": code_resp.get("code_verifier", ""),
        }, headers={"Content-Type": "application/x-www-form-urlencoded"})
        if token_resp.status_code != 200:
            raise HexbotError(4211, f"OpenAI token exchange failed (HTTP {token_resp.status_code}).")
        tokens = token_resp.json()
        if not tokens.get("access_token"):
            raise HexbotError(4211, "OpenAI did not return an access token.")
    auth._save_codex_tokens({"access_token": tokens["access_token"],
                             "refresh_token": tokens.get("refresh_token", "")})


def _xai_flow(login: Login) -> None:
    import httpx
    from hermes_cli import auth

    discovery = auth._xai_oauth_discovery(20.0)
    with httpx.Client(timeout=httpx.Timeout(20.0), headers={"Accept": "application/json"}) as client:
        data = auth._xai_oauth_request_device_code(client)
        login.url = str(data.get("verification_uri_complete") or data["verification_uri"])
        login.code, login.status = str(data["user_code"]), "pending"
        login.ready.set()
        payload = auth._xai_oauth_poll_device_token(
            client, token_endpoint=discovery["token_endpoint"],
            device_code=str(data["device_code"]), expires_in=int(data["expires_in"]),
            poll_interval=int(data["interval"]))
    if login.cancel.is_set():
        return
    tokens = {"access_token": str(payload.get("access_token") or "").strip(),
              "refresh_token": str(payload.get("refresh_token") or "").strip(),
              "id_token": str(payload.get("id_token") or "").strip(),
              "expires_in": payload.get("expires_in"),
              "token_type": str(payload.get("token_type") or "Bearer")}
    if not tokens["access_token"]:
        raise HexbotError(4211, "xAI did not return an access token.")
    auth._save_xai_oauth_tokens(tokens, discovery=discovery)


def _nous_flow(login: Login) -> None:
    from hermes_cli import auth

    def on_verification(url: str, code: str) -> None:
        login.url, login.code, login.status = url, code, "pending"
        login.ready.set()

    state = auth._nous_device_code_login(open_browser=False, on_verification=on_verification)
    if login.cancel.is_set():
        return
    with auth._auth_store_lock():
        store = auth._load_auth_store()
        auth._save_provider_state(store, "nous", state)
        auth._save_auth_store(store)


FLOWS = {"openai-codex": _codex_flow, "xai-oauth": _xai_flow, "nous": _nous_flow}


def _run(login: Login, flow) -> None:
    try:
        flow(login)
        if login.cancel.is_set():
            login.status, login.message = "cancelled", "Sign-in cancelled."
        else:
            login.status, login.message = "done", "Signed in."
    except HexbotError as exc:
        login.status, login.message = "error", exc.message
    except Exception as exc:  # noqa: BLE001 - surfaced to the client
        logger.warning("provider sign-in failed for %s", login.provider, exc_info=True)
        login.status, login.message = "error", str(exc) or "Sign-in failed."
    finally:
        login.ready.set()


def start(provider: str) -> dict:
    from hexbot.providers import canonical_provider
    slug = canonical_provider(provider)
    flow = FLOWS.get(slug)
    if flow is None:
        return {"supported": False, "provider": slug,
                "message": f"Sign in from a terminal with: hexbot core auth login {slug}"}
    with _lock:
        for other in list(_logins.values()):
            if other.provider == slug and other.status in ("starting", "pending"):
                other.cancel.set()
        login = Login(id=uuid.uuid4().hex, provider=slug)
        _logins[login.id] = login
        _logins_prune()
    threading.Thread(target=_run, args=(login, flow), name=f"hexbot-login-{slug}", daemon=True).start()
    login.ready.wait(30)
    return {"supported": True, **login.public()}


def poll(login_id: str) -> dict:
    login = _logins.get(login_id)
    if login is None:
        raise HexbotError(4210, "unknown sign-in")
    return login.public()


def cancel(login_id: str) -> dict:
    login = _logins.get(login_id)
    if login is None:
        raise HexbotError(4210, "unknown sign-in")
    login.cancel.set()
    if login.status in ("starting", "pending"):
        login.status, login.message = "cancelled", "Sign-in cancelled."
    return login.public()


def _logins_prune() -> None:
    finished = [k for k, v in _logins.items() if v.status in ("done", "error", "cancelled")]
    for key in finished[:-20]:
        _logins.pop(key, None)
