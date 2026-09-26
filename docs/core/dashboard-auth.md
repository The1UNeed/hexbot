# Core dashboard-auth: interface map for a Hexbot device-pairing provider

Read at the v0.21.0 fork point. Line numbers are as read.

## 1. `DashboardAuthProvider`

`/Users/alex/Desktop/Projects/Hexbot/hermes_cli/dashboard_auth/base.py`

Dataclasses: `Session` (L9-25) — `user_id, email, display_name, org_id, provider, expires_at (unix s), access_token, refresh_token`, all mandatory, tokens opaque to Hexbot. `TokenPrincipal` (L28-53) — `principal, provider, scopes: tuple[str,...]`. `LoginStart` (L56-77) — `redirect_url, cookie_payload: dict[str,str]`.

Exceptions: `ProviderError`→503, `InvalidCodeError`→400, `InvalidCredentialsError`→401, `RefreshExpiredError` (try next provider). `classify_jwks_lookup_error` (L113) maps PyJWT failures onto that split.

Class `DashboardAuthProvider(ABC)` (L152). Class attrs: `name`, `display_name` (both required non-empty), `supports_password=False` (L213), `supports_token=False` (L225), `supports_session=True` (L232).

Abstract methods (L234-254) — signatures verbatim, all keyword-only:
- `start_login(self, *, redirect_uri: str) -> LoginStart`
- `complete_login(self, *, code: str, state: str, code_verifier: str, redirect_uri: str) -> Session`
- `verify_session(self, *, access_token: str) -> Optional[Session]` — return `None` for unrecognised/expired (never raise); `ProviderError` only for a genuine outage.
- `refresh_session(self, *, refresh_token: str) -> Session` — raise `RefreshExpiredError` when dead.
- `revoke_session(self, *, refresh_token: str) -> None` — best-effort, must not raise.

Non-abstract, default raises `NotImplementedError`:
- `complete_password_login(self, *, username: str, password: str) -> Session` (L256-284)
- `verify_token(self, *, token: str) -> Optional[TokenPrincipal]` (L286-317) — consulted only when `supports_token`; must use `hmac.compare_digest`.

`assert_protocol_compliance(cls)` (L320) enforces name/display_name + the five methods + no leftover abstracts; called by `register_provider`.

**Selection / config.** There is **no `dashboard.auth` config namespace** — I grepped `dashboard.auth.` across `.py/.yaml/.md`: zero hits. Selection is implicit: each plugin's `register(ctx)` decides for itself whether to register, and every registered provider is stacked (verify loops iterate all of them). Existing surfaces: `dashboard.basic_auth.{username,password,password_hash,secret,session_ttl_seconds}` + `HERMES_DASHBOARD_BASIC_AUTH_*`; `dashboard.oauth.client_id` + `HERMES_DASHBOARD_OAUTH_CLIENT_ID` (nous); `dashboard.oauth.self_hosted.*` + `HERMES_DASHBOARD_OIDC_*`; `dashboard.drain_auth.*` + `HERMES_DASHBOARD_DRAIN_SECRET`. Env wins over config when non-empty.

**Registration.** Plugin hook `ctx.register_dashboard_auth_provider(provider)` — `hermes_cli/plugins.py:2455-2513`. It type-checks against `DashboardAuthProvider`, calls `register_global_provider` (process-global upsert slot), tracks the handle with `persistent=True` so a per-home plugin-manager teardown cannot empty the registry (#91701). Bad type / duplicate → WARNING, ignored, never raises. Registry: `hermes_cli/dashboard_auth/registry.py` — `register_provider` (L31, raises on dup), `register_global_provider` (L125, upsert), `list_providers/list_token_providers/list_session_providers` (L98-122).

Manifest shape (`plugins/dashboard_auth/basic/plugin.yaml`): `name`, `version`, `description`, `author`, `kind: backend`, `requires_env: [...]`. Bundled providers live at `plugins/dashboard_auth/{basic,nous,self_hosted,drain}/`. Discovery is the ordinary `discover_plugins()` (`hermes_cli/main.py:11967-11969`, forced before `start_server`).

**Bundled `basic`** (`plugins/dashboard_auth/basic/__init__.py`): `name="basic"`, `display_name="Username & Password"`, `supports_password=True`. `start_login`/`complete_login` raise `NotImplementedError` (L229-241). `complete_password_login` (L244) does constant-time username compare + always-run scrypt (dummy hash on unknown user), then `_mint_session`. Sessions are **stateless HMAC-SHA256-signed base64url blobs** — `_sign`/`_unsign` (L176-198) over `{"sub","kind":"access"|"refresh","exp"}`; access TTL 12h, refresh TTL 30d. `verify_session` (L263) unsigns + checks `kind=="access"` + exp. `refresh_session` (L273) same for `kind=="refresh"`, mints a fresh pair. `revoke_session` (L285) is a **no-op — stateless tokens cannot be revoked**. `register()` at L394-491.

## 2. Routes — `hermes_cli/dashboard_auth/routes.py`

Mounted in `web_server.py:19297-19301`.

| Route | Auth | Request | Response |
|---|---|---|---|
| `GET /login` (L150) | public | `?next=` | HTML login page, `Cache-Control: no-store` |
| `GET /api/auth/providers` (L170) | public | — | `{"providers":[{name,display_name,supports_password}]}`; 503 `{"detail":"no auth providers registered"}` when empty |
| `GET /auth/login` (L200) | public | `?provider=&next=` | 302 → IDP + PKCE cookie; password providers 302 → `/login`; 404 unknown / non-session provider; 503 unreachable |
| `GET /auth/native/authorize` (L308) | public | `?provider=&code_challenge=&code_challenge_method=S256&redirect_uri=&state=` | 302 → IDP (or `/login` for password providers) + PKCE cookie carrying `broker`. 400 non-S256 / missing challenge / non-loopback redirect_uri (`127.0.0.1` or `::1` literals only, `localhost` rejected — L272-307); 503 store at capacity |
| `GET /auth/callback` (L444) | public | `?code=&state=` + PKCE cookie | broker branch → 302 to `redirect_uri?code=<gw_code>&state=<client_state>`, **no session cookies**; else 302 to `next` + session cookies |
| `POST /auth/password-login` (L714) | public | `{provider, username, password, next?}` | `{"ok":true,"next":"<path or loopback url>"}` + session cookies (none in broker branch). 429 rate-limited / 404 unknown provider / 401 `Invalid credentials` / 503 / 400 broker provider mismatch |
| `POST /auth/logout` (L890) | public prefix | — | best-effort `revoke_session` on every provider with the RT cookie, 302 → `{prefix}/login`, clears session + PKCE cookies |
| `GET /api/auth/me` (L926) | gated | — | `{user_id,email,display_name,org_id,provider,expires_at}` from `request.state.session`; 401 otherwise |
| `POST /api/auth/ws-ticket` (L947) | gated | — | `{"ticket": "<43-char base64url>", "ttl_seconds": 30}` |
| `POST /auth/native/token` (L989) | public | `{code, code_verifier}` | `{access_token, refresh_token, token_type:"Bearer", expires_at, provider, user_id}`; 400 on any failure (code consumed on every path) |
| `POST /auth/native/refresh` (L1042) | public | `{refresh_token, provider?}` | same body shape; 401 `{"error":"session_expired",...}` when all providers reject; 503 if any unreachable |

There is **no device-code endpoint** (`/device/code`, `verification_uri`, polling). The only "start" endpoints are `/auth/login` and `/auth/native/authorize` (PKCE-S256). Broker store: `native_flow.py` — pending TTL 600s, code TTL 120s, 256-entry global cap, 8 pending per IP, `redeem_code` pops before the PKCE compare so there is no verifier oracle.

## 3. Cookies — `hermes_cli/dashboard_auth/cookies.py`

Names (L82-97): `hermes_session_at`, `hermes_session_rt`, `hermes_session_provider`, `hermes_session_pkce`, `hermes_sso_attempt`. Attributes via `_common_attrs` (L152-160): `HttpOnly=True`, `SameSite=Lax`, `Path = prefix or "/"`, and **`Secure` only when `detect_https(request)` is true** (L517-525: `request.url.scheme == "https"`). So **plain-HTTP LAN use is not blocked** — over HTTP the cookies are bare-named, non-Secure, Lax. Cookie *name* prefixing (`_resolved_name`, L122): bare over HTTP, `__Host-` over HTTPS at Path=/, `__Secure-` over HTTPS behind a proxy prefix. PKCE cookie is the exception: `SameSite=None` over HTTPS, Lax over HTTP (`_pkce_attrs`, L289).

Lifetimes: AT cookie `max_age = access_token_expires_in` (provider's TTL); RT cookie `_RT_MAX_AGE = 30d` (L111); PKCE `10m`; SSO marker `60s`. Empty `refresh_token` ⇒ RT cookie simply not written (L215).

**Storage: none.** No DB table, no server-side session store. Sessions are whatever the provider's opaque tokens encode (`basic` = HMAC blobs; `nous` = Portal JWTs). Revocation is therefore entirely the provider's business via `revoke_session` — `basic` cannot revoke at all. `clear_session_cookies` (L270) emits Max-Age=0 for all three name variants of AT/RT/provider.

## 4. ws-ticket flow — `hermes_cli/dashboard_auth/ws_tickets.py`

1. Authenticated `POST /api/auth/ws-ticket` → `mint_ticket(user_id=sess.user_id, provider=sess.provider)` (routes L947-976). `secrets.token_urlsafe(32)`, in-process dict `_tickets: ticket -> (expires_at, {user_id, provider, minted_at})`, `TTL_SECONDS = 30` (L42).
2. Client attaches `?ticket=` — or, for `/api/ws`, the subprotocol form `hermes-gateway-ticket.<ticket>` alongside `hermes-gateway-v1` (`web_server.py:16489-16502`).
3. `_ws_auth_reason` (`web_server.py:16505-16616`) calls `consume_ticket` (single-use pop) and stamps `ws._hermes_auth_identity = {"user_id","provider"}` (L16590-16593). `?internal=<credential>` is the multi-use, never-expiring process credential for server-spawned children, identity `server-internal`.
4. `gateway_ws` passes it on: `handle_ws(ws, auth_identity=getattr(ws, "_hermes_auth_identity", None), ...)` (`web_server.py:17747-17751`) → `WSTransport.auth_identity` (`tui_gateway/ws.py:118,130,347-385`).

**Per-connection identity available to RPC methods**: yes — `getattr(transport, "auth_identity", None)` in `tui_gateway/methods_browser_control.py:172,262,324,359`. It is the sole identity authority for privileged registration; RPC params can never supply it. `/api/pub`, `/api/events`, `/api/pty`, `/api/console` call `_ws_auth_ok` but drop the dict.

## 5. `should_require_auth()` / `_ws_client_is_allowed()`

`should_require_auth(host, allow_public=False)` — `web_server.py:828-847` — is one line: `return host not in {"localhost","127.0.0.1","::1"}`. `allow_public` / `--insecure` is accepted and **ignored**. So `0.0.0.0` ⇒ `True` regardless of provider; loopback ⇒ `False`. `should_require_dashboard_auth` (L850) ORs in a non-loopback `dashboard.public_url`. `_desktop_loopback_auth_exempt` (L878) keeps a Desktop-spawned loopback backend ungated when `HERMES_DESKTOP=1` + a credential is present. Startup fails closed if `auth_required` and `list_providers()` is empty (L19745-19750).

`_ws_client_is_allowed` (L16368-16409): `if app.state.auth_required: return True` — with a 0.0.0.0 bind and our provider active, **every peer IP passes**; the real checks are `_ws_host_origin_is_allowed` (Host must match `bound_host` or `trusted_public_hosts`; non-http/https Origins such as Electron `file://`/`app://` are trusted) and `_ws_auth_ok`. On loopback with the gate off, only loopback peers pass, and empty `ws.client.host` fails closed.

**Loopback + native client while a LAN gate is on**: these are different processes. `auth_required` is per-process from that process's own bind/public_url. A loopback daemon is ungated and the injected `_SESSION_TOKEN` works; a 0.0.0.0 daemon is gated and `_ws_auth_reason` rejects `?token=` unconditionally (L16610-16616) while `_serve_index` stops injecting the token (L18023-18035). A single 0.0.0.0 daemon therefore cannot serve a local Electron client over the legacy token — unless it is the Desktop-exempt loopback case above.

## 6. Smallest edits for a Hexbot device-token provider

**(a) Long-lived device token on HTTP: zero core edits.** `gated_auth_middleware` already runs a bearer path for *every* gated non-public route before touching cookies (`middleware.py:331-374`): `_extract_bearer` → `_verify_bearer` → `verify_session(access_token=...)` across all `supports_session` providers → `request.state.session = bearer_session`, then pass through. Make the device token the `Session.access_token` your `verify_session` recognises (long `expires_at`, `refresh_token=""`) and `Authorization: Bearer <device_token>` authenticates every REST call, `/api/auth/me` and `/api/auth/ws-ticket` included. `_require_token` (`web_server.py:765-792`) defers to the gate when `auth_required`, so it doesn't interfere.

**(b) Long-lived device token on WS: zero core edits, one extra round trip.** The client POSTs `/api/auth/ws-ticket` with the bearer, gets a 30s single-use ticket, and opens `/api/ws?ticket=…` (or the `hermes-gateway-ticket.<t>` subprotocol). The ticket carries `{user_id, provider}` into `WSTransport.auth_identity`, so per-connection identity works for free. Only if you want the device token accepted *directly* on the upgrade would you edit core: the exact site is `hermes_cli.web_server._ws_auth_reason`, inside the `if auth_required:` block, adding a branch that reads a device token and calls the session-provider stack — but this widens the WS credential surface from 30s-single-use to long-lived, so I'd skip it.

**Pairing UI: needs a plugin-side route, not a core edit.** The bundled login page renders exactly two shapes (redirect button or password form, `login_page.py:461-504`) and there is no device-code endpoint. Cheapest plugin-only path: set `supports_password = True` and treat the short pairing code as the "password" (`complete_password_login(username="pair", password=<code>)`), returning a Session whose `access_token` is the minted device token. That reuses `/login`, `/auth/password-login`, `/auth/native/authorize` (which routes password providers to `/login`), the loopback code exchange, and cookies — no core change at all. LAN browsers then get cookies; Electron gets the token in the `/auth/native/token` JSON body and never holds a cookie.

**Being the only gate: no edit needed.** Don't register the other providers (leave `dashboard.basic_auth` / `HERMES_DASHBOARD_OAUTH_CLIENT_ID` / OIDC / drain unset). With one registered provider, `list_session_providers()` has length 1 and the verify/refresh/login loops only ever call yours. Note `_auto_sso_response` (`middleware.py:227-244`) explicitly opts out for `supports_password` providers, which is what you want for a pairing form.

**Revocation is yours to build.** There is no core session store; `revoke_session` is best-effort and `/auth/logout` fans it out to every provider with the RT cookie. A revocable device token means your provider keeps its own table (SQLite under `~/.hexbot`) and checks it in `verify_session` — which is also the only way `POST /api/auth/ws-ticket` stops minting tickets for a revoked device. Already-minted tickets stay valid for their remaining ≤30s; live WS connections are not torn down by revocation anywhere in this code (unverified for any path outside `dashboard_auth/` + `web_server.py` WS handlers).
