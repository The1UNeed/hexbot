import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "@/lib/store";
import { FakeTunnelProvider } from "@/lib/tunnels";
import { setRuntimeForTests } from "@/lib/runtime";
import { hashToken, pkceChallenge, randomToken, verifyGrant } from "@/lib/tokens";
import { startBrowserSignIn } from "@/lib/browser-signin";
import { POST as start } from "@/app/api/register/start/route";
import { POST as approve } from "@/app/api/register/approve/route";
import { POST as poll } from "@/app/api/register/poll/route";
import { POST as exchange } from "@/app/api/grants/exchange/route";

const request = (path: string, body?: unknown, token?: string) => new Request(`http://localhost${path}`, { method: "POST", headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
let store: MemoryStore;
beforeEach(() => { process.env.DEV_USER_ID = "clerk-dev-user"; delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY; store = new MemoryStore(); setRuntimeForTests({ store, tunnels: new FakeTunnelProvider() }); });

async function registeredDaemon() {
  const started = await (await start(request("/api/register/start", { daemon_name: "Studio Mac", platform: "darwin" }))).json();
  await approve(request("/api/register/approve", { user_code: started.user_code }));
  const credentials = await (await poll(request("/api/register/poll", { device_code: started.device_code }))).json();
  return { daemon: store.daemons[0], daemonToken: credentials.daemon_token as string, user: store.users[0] };
}
const verifier = "v".repeat(64);
const params = (daemonId: string, redirectUri: string) => ({ daemon: daemonId, state: "nonce-1", code_challenge: pkceChallenge(verifier), redirect_uri: redirectUri });

describe("browser sign-in", () => {
  it("asks a signed-out visitor to sign in, and refuses another user's daemon", async () => {
    const { daemon } = await registeredDaemon();
    const redirectUri = `http://127.0.0.1:${daemon.ingressPort}/auth/callback`;
    expect(await startBrowserSignIn(params(daemon.id, redirectUri), { store, userId: null, deviceName: "Safari on iPhone", fakeTunnels: true })).toEqual({ kind: "sign-in", daemonName: "Studio Mac" });
    expect((await startBrowserSignIn(params(daemon.id, redirectUri), { store, userId: "someone-else", deviceName: "Safari on iPhone", fakeTunnels: true })).kind).toBe("wrong-account");
    expect(store.grantCodes).toHaveLength(0);
  });

  it("rejects an incomplete request or a callback that is not the daemon's own", async () => {
    const { daemon, user } = await registeredDaemon();
    const bad = (overrides: Record<string, string>) => startBrowserSignIn({ ...params(daemon.id, `http://127.0.0.1:${daemon.ingressPort}/auth/callback`), ...overrides }, { store, userId: user.id, deviceName: "Chrome on macOS", fakeTunnels: true });
    expect((await bad({ redirect_uri: "https://evil.example/auth/callback" })).kind).toBe("invalid");
    expect((await bad({ code_challenge: "short" })).kind).toBe("invalid");
    expect((await bad({ daemon: "missing" })).kind).toBe("invalid");
    // The daemon names its public hostname; through Cloudflare nothing else is accepted.
    expect((await startBrowserSignIn(params(daemon.id, `https://${daemon.tunnelHostname}/auth/callback`), { store, userId: user.id, deviceName: "Chrome on macOS", fakeTunnels: false })).kind).toBe("redirect");
    expect((await startBrowserSignIn(params(daemon.id, `http://127.0.0.1:${daemon.ingressPort}/auth/callback`), { store, userId: user.id, deviceName: "Chrome on macOS", fakeTunnels: false })).kind).toBe("invalid");
  });

  it("hands the owner back to the daemon with a one-time code the daemon exchanges for a grant", async () => {
    const { daemon, daemonToken, user } = await registeredDaemon();
    const redirectUri = `http://127.0.0.1:${daemon.ingressPort}/auth/callback`;
    const result = await startBrowserSignIn(params(daemon.id, redirectUri), { store, userId: user.id, deviceName: "Chrome on macOS", fakeTunnels: true });
    if (result.kind !== "redirect") throw new Error(result.kind);
    const url = new URL(result.href);
    expect(`${url.origin}${url.pathname}`).toBe(redirectUri);
    expect(url.searchParams.get("state")).toBe("nonce-1");
    const code = url.searchParams.get("code")!;
    expect(code.startsWith("hxg_")).toBe(true);
    expect(store.grantCodes[0].codeHash).toBe(hashToken(code));

    const wrongVerifier = await exchange(request("/api/grants/exchange", { code, code_verifier: "w".repeat(64), redirect_uri: redirectUri }, daemonToken));
    expect(wrongVerifier.status).toBe(400);
    const noToken = await exchange(request("/api/grants/exchange", { code, code_verifier: verifier, redirect_uri: redirectUri }));
    expect(noToken.status).toBe(401);
    const ok = await exchange(request("/api/grants/exchange", { code, code_verifier: verifier, redirect_uri: redirectUri }, daemonToken));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.device_name).toBe("Chrome on macOS");
    const claims = await verifyGrant(body.grant, daemon.id);
    expect(claims).toMatchObject({ sub: user.id, daemon_id: daemon.id, device_name: "Chrome on macOS" });
    expect(claims.jti).toBeTruthy();
    const again = await exchange(request("/api/grants/exchange", { code, code_verifier: verifier, redirect_uri: redirectUri }, daemonToken));
    expect(again.status).toBe(409);
  });

  it("refuses a code minted for another daemon, and an expired one", async () => {
    const { daemon, daemonToken, user } = await registeredDaemon();
    const code = randomToken("hxg_");
    await store.createGrantCode({ codeHash: hashToken(code), daemonId: "other-daemon", userId: user.id, deviceName: "Firefox on Linux", challenge: pkceChallenge(verifier), redirectUri: "x", expiresAt: new Date(Date.now() + 60_000) });
    expect((await exchange(request("/api/grants/exchange", { code, code_verifier: verifier, redirect_uri: "x" }, daemonToken))).status).toBe(404);
    const stale = randomToken("hxg_");
    await store.createGrantCode({ codeHash: hashToken(stale), daemonId: daemon.id, userId: user.id, deviceName: "Firefox on Linux", challenge: pkceChallenge(verifier), redirectUri: "x", expiresAt: new Date(Date.now() - 1) });
    expect((await exchange(request("/api/grants/exchange", { code: stale, code_verifier: verifier, redirect_uri: "x" }, daemonToken))).status).toBe(410);
  });
});
