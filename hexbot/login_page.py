"""The daemon's sign-in page, shown to a browser that reaches a gated daemon without a session.

Replaces the core's page through ``set_login_renderer``. Same routes, forms, and field
names as the core page, so the auth flow is unchanged; only the look and the words are Hexbot's.
Self-contained: no bundle, fonts, or network requests, because it renders before the app loads.
"""

from __future__ import annotations

import html
from urllib.parse import quote

from hermes_cli.dashboard_auth import list_session_providers

LOGO = ('<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M44 6a12 12 0 0 1 12 0l30 17a12 12 0 0 1 6 10v34a12 12 '
        '0 0 1-6 10L56 94a12 12 0 0 1-12 0L14 77a12 12 0 0 1-6-10V33a12 12 0 0 1 6-10Z" fill="currentColor"/><rect '
        'x="31" y="35" width="13" height="30" rx="6.5" fill="var(--bg)"/><rect x="56" y="35" width="13" height="30" '
        'rx="6.5" fill="var(--bg)"/></svg>')
ICON = ("data:image/svg+xml," + quote(LOGO.replace('fill="currentColor"', 'fill="#141414"')
                                      .replace('fill="var(--bg)"', 'fill="#fff"')
                                      .replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')))

# The app's tokens (apps/web/src/styles/tokens.css), light and dark.
PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · Hexbot</title>
<link rel="icon" href="{icon}">
<style>
  :root {{ --bg: #fff; --surface: #f5f5f5; --text: #141414; --muted: #767676; --border: #e3e3e3; --danger: #d92d20;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, Inter, 'Segoe UI', sans-serif; }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --bg: #0e0e0e; --surface: #171717; --text: #f4f4f4; --muted: #8e8e8e; --border: #2a2a2a; --danger: #f4645b; }}
  }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--surface);
    color: var(--text); font-size: 15px; line-height: 1.5; -webkit-font-smoothing: antialiased; }}
  main {{ width: 100%; max-width: 380px; }}
  .brand {{ display: flex; align-items: center; gap: 10px; justify-content: center; margin-bottom: 20px;
    font-weight: 600; font-size: 20px; }}
  .brand svg {{ width: 32px; height: 32px; }}
  .card {{ background: var(--bg); border: 1px solid var(--border); border-radius: 16px; padding: 28px; }}
  h1 {{ margin: 0 0 6px; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }}
  p {{ margin: 0; color: var(--muted); }}
  .stack {{ display: grid; gap: 12px; margin-top: 22px; }}
  .provider-btn {{ display: block; width: 100%; padding: 11px 16px; border: 0; border-radius: 999px; background: var(--text);
    color: var(--bg); font: inherit; font-weight: 600; text-align: center; text-decoration: none; cursor: pointer; }}
  .provider-btn:disabled {{ opacity: .5; cursor: default; }}
  .or {{ display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 13px; }}
  .or::before, .or::after {{ content: ""; flex: 1; height: 1px; background: var(--border); }}
  form {{ display: grid; gap: 12px; }}
  label {{ display: grid; gap: 6px; font-size: 13px; font-weight: 500; }}
  input {{ width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg);
    color: var(--text); font: inherit; }}
  input:focus {{ outline: 2px solid var(--text); outline-offset: 1px; }}
  .code {{ font-family: ui-monospace, 'SF Mono', Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; }}
  .hint, .form-error {{ font-size: 13px; }}
  .form-error {{ color: var(--danger); }}
  code {{ font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 13px; }}
</style>
</head>
<body>
<main>
  <div class="brand">{logo}Hexbot</div>
  <div class="card">
{body}
  </div>
</main>
{script}
</body>
</html>
"""

# Posts a pairing form to /auth/password-login, as the core page does, with pairing words for the errors.
SCRIPT = """<script>
document.querySelectorAll('form.provider-form').forEach(function (form) {
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var error = form.querySelector('.form-error'), button = form.querySelector('button');
    error.hidden = true; button.disabled = true;
    var value = function (name) { return form.querySelector('[name=' + name + ']').value; };
    fetch('/auth/password-login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: form.dataset.provider, username: value('username'), password: value('password'), next: value('next') }) })
      .then(function (response) {
        if (response.ok) return response.json().then(function (data) { window.location.assign((data && data.next) || '/'); });
        throw new Error(response.status === 429 ? 'Too many attempts. Wait a minute and try again.'
          : response.status === 401 ? 'That code did not work. Codes expire after ten minutes.' : 'Sign-in failed. Try again.');
      })
      .catch(function (reason) {
        error.textContent = reason instanceof TypeError ? 'Could not reach the daemon. Try again.' : reason.message;
        error.hidden = false; button.disabled = false;
      });
  });
});
</script>"""


def render_login_html(*, next_path: str = "") -> str:
    """The sign-in page; ``next_path`` has already been checked same-origin by the caller."""
    providers = list_session_providers()
    if not providers:
        return PAGE.format(title="Sign-in unavailable", icon=ICON, logo=LOGO, script="", body=(
            "    <h1>Sign-in unavailable</h1>\n    <p>This daemon accepts connections from other devices but has no way"
            " to sign them in. Restart it with <code>hexbot serve</code>, or bind it to <code>127.0.0.1</code>.</p>"))
    next_attr = html.escape(next_path, quote=True)
    next_query = f"&next={html.escape(quote(next_path, safe=''), quote=True)}" if next_path else ""
    links = [f'      <a class="provider-btn" href="/auth/login?provider={html.escape(p.name, quote=True)}{next_query}">'
             f'Sign in with {html.escape(p.display_name)}</a>' for p in providers if not getattr(p, "supports_password", False)]
    forms = [f"""      <form class="provider-form" data-provider="{html.escape(p.name, quote=True)}">
        <input type="hidden" name="next" value="{next_attr}">
        <label>Device name<input name="username" autocomplete="username" placeholder="My laptop" required></label>
        <label>Pairing code<input class="code" name="password" autocomplete="one-time-code" autocapitalize="characters"
          spellcheck="false" placeholder="XXXX-XXXX" required></label>
        <div class="form-error" role="alert" hidden></div>
        <button class="provider-btn" type="submit">Sign in with a pairing code</button>
        <p class="hint">Get a code in the Hexbot app under Settings, Network, or run <code>hexbot pair</code> where the daemon runs.</p>
      </form>""" for p in providers if getattr(p, "supports_password", False)]
    body = ["    <h1>Sign in</h1>", "    <p>This daemon asks who you are before it lets a new device in.</p>",
            '    <div class="stack">', *links, *(['      <div class="or">or</div>'] if links and forms else []), *forms, "    </div>"]
    return PAGE.format(title="Sign in", icon=ICON, logo=LOGO, body="\n".join(body), script=SCRIPT if forms else "")
