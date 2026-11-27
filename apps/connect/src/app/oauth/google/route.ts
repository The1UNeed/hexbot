import { currentUser, signInPath } from "@/lib/auth";
import { daemonOrigin } from "@/lib/daemons";
import { fakeTunnels, getStore } from "@/lib/runtime";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const page = (status: number, text: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hexbot</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f7f7f5;color:#1d1d1b}@media(prefers-color-scheme:dark){body{background:#161615;color:#ededeb}}main{max-width:28rem;padding:24px}</style><main><p>${text}</p></main>`,
    { status, headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8" } },
  );

const escape = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/**
 * Where Google returns from a daemon's sign-in to Gmail, Drive and the other Google connectors when the
 * browser isn't on the daemon's computer (DESIGN.md, Hex Connect). Google needs one fixed address, and
 * a daemon's tunnel hostname is its own, so the daemon starts its state with its id and this sends the
 * browser on to that daemon's `/oauth/google` with the query unchanged, but only for the daemon's own
 * Connect account, as browser sign-in does: anyone can start a sign-in on their daemon and send someone
 * else the consent page, and the code would complete there with the key that daemon holds. A signed-out
 * browser (a phone's, usually) signs in first; Google's answer waits meanwhile in a cookie only this
 * address reads, so the code never rides in the sign-in page's address. Nothing is stored or logged.
 */
const COOKIE = "hexbot_google_return";
const cookie = (url: URL, value: string, maxAge: number) =>
  `${COOKIE}=${encodeURIComponent(value)}; Path=/oauth/google; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${url.protocol === "https:" ? "; Secure" : ""}`;
const held = (request: Request) => {
  const raw = /(?:^|;\s*)hexbot_google_return=([^;]*)/.exec(request.headers.get("cookie") ?? "")?.[1];
  try { return raw ? decodeURIComponent(raw) : ""; } catch { return ""; }
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  // Back from signing in to Connect, with Google's answer in the cookie.
  if (!url.search) url.search = held(request);
  const id = /^([0-9a-f-]{36})\./i.exec(url.searchParams.get("state") ?? "")?.[1];
  if (!id) return page(400, "This address isn't from a Hexbot sign-in. Start it again in Hexbot, Settings, Plugins.");
  const daemon = await getStore().getDaemon(id);
  if (!daemon || daemon.revokedAt) return page(404, "This daemon is no longer on Hex Connect. Start the sign-in again in Hexbot, Settings, Plugins.");
  const user = await currentUser();
  if (!user) {
    const headers = new Headers({ ...HEADERS, Location: new URL(signInPath("/oauth/google"), url).href });
    headers.append("Set-Cookie", cookie(url, url.search, 15 * 60));
    return new Response(null, { status: 303, headers });
  }
  if (user.id !== daemon.userId) return page(403, `${escape(daemon.name)} belongs to another Hex Connect account, so the sign-in stops here. Sign in to Connect with the account that owns it, then start again in Hexbot, Settings, Plugins.`);
  const target = new URL(`${daemonOrigin(daemon, fakeTunnels())}/oauth/google`);
  target.search = url.search;
  const headers = new Headers({ ...HEADERS, Location: target.href });
  headers.append("Set-Cookie", cookie(url, "", 0));
  return new Response(null, { status: 303, headers });
}
