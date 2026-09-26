import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "@/lib/store";
import { FakeTunnelProvider } from "@/lib/tunnels";
import { setRuntimeForTests } from "@/lib/runtime";
import { hashToken, randomToken } from "@/lib/tokens";
import { POST as start } from "@/app/api/register/start/route";
import { POST as approve } from "@/app/api/register/approve/route";
import { POST as poll } from "@/app/api/register/poll/route";
import { POST as grant } from "@/app/api/daemons/[id]/grant/route";
import { POST as heartbeat } from "@/app/api/daemons/[id]/heartbeat/route";
import { DELETE as remove } from "@/app/api/daemons/[id]/route";
import AuthorizePage from "@/app/connect/authorize/page";
import { authorizeClient } from "@/app/connect/authorize/actions";

const request = (path: string, body?: unknown, token?: string, method = "POST") => new Request(`http://localhost${path}`, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
let store: MemoryStore; let tunnels: FakeTunnelProvider;
beforeEach(() => { process.env.DEV_USER_ID = "clerk-dev-user"; delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY; store = new MemoryStore(); tunnels = new FakeTunnelProvider(); setRuntimeForTests({ store, tunnels }); });

async function registration() {
  const startedResponse = await start(request("/api/register/start", { daemon_name: "Home", platform: "linux" })); const started = await startedResponse.json();
  const approvedResponse = await approve(request("/api/register/approve", { user_code: started.user_code })); expect(approvedResponse.status).toBe(200);
  return { started, approved: await approvedResponse.json() };
}

describe("registration lifecycle", () => {
  it("starts, approves, returns credentials once, then reports consumption", async () => { const { started } = await registration(); const firstResponse = await poll(request("/api/register/poll", { device_code: started.device_code })); expect(firstResponse.status).toBe(200); const first = await firstResponse.json(); expect(first).toMatchObject({ status: "approved", slug: expect.any(String), daemon_token: expect.stringMatching(/^hxd_/), tunnel_token: expect.stringMatching(/^fake-tunnel-token-/) }); const second = await poll(request("/api/register/poll", { device_code: started.device_code })); expect(second.status).toBe(410); expect((await second.json()).error).toBe("consumed"); });
});

describe("authenticated daemon routes", () => {
  it("requires a client session before issuing a grant", async () => { const { approved } = await registration(); const denied = await grant(request(`/api/daemons/${approved.daemon_id}/grant`), { params: Promise.resolve({ id: approved.daemon_id }) }); expect(denied.status).toBe(401); const user = store.users[0]; const clientToken = randomToken("hxc_"); await store.createClientSession({ userId: user.id, tokenHash: hashToken(clientToken), deviceName: "Laptop" }); const allowed = await grant(request(`/api/daemons/${approved.daemon_id}/grant`, undefined, clientToken), { params: Promise.resolve({ id: approved.daemon_id }) }); expect(allowed.status).toBe(200); const body = await allowed.json(); expect(body.grant.split(".")).toHaveLength(3); expect(body.daemon).toMatchObject({ host: "127.0.0.1", port: 9119, tls: false }); });
  it("updates last_seen_at on heartbeat", async () => { const { started, approved } = await registration(); const polled = await poll(request("/api/register/poll", { device_code: started.device_code })); const credentials = await polled.json(); const response = await heartbeat(request(`/api/daemons/${approved.daemon_id}/heartbeat`, { port: 8000 }, credentials.daemon_token), { params: Promise.resolve({ id: approved.daemon_id }) }); expect(response.status).toBe(200); expect(store.daemons[0].lastSeenAt).toBeInstanceOf(Date); });
  it("revokes the daemon and deletes its tunnel", async () => { const { approved } = await registration(); const user = store.users[0]; const clientToken = randomToken("hxc_"); await store.createClientSession({ userId: user.id, tokenHash: hashToken(clientToken), deviceName: "Laptop" }); const response = await remove(request(`/api/daemons/${approved.daemon_id}`, undefined, clientToken, "DELETE"), { params: Promise.resolve({ id: approved.daemon_id }) }); expect(response.status).toBe(200); expect(store.daemons[0].revokedAt).toBeInstanceOf(Date); expect(tunnels.deleted).toEqual([store.daemons[0].tunnelId]); });
});

describe("tunnel hostnames and ports", () => {
  it("places daemons one label under the zone and moves the tunnel to the heartbeat port", async () => {
    process.env.CONNECT_DOMAIN = "hexbot.app";
    const { started, approved } = await registration();
    expect(approved.hostname).toMatch(/^[a-z]+-[a-z]+-\d+\.hexbot\.app$/);
    const credentials = await (await poll(request("/api/register/poll", { device_code: started.device_code }))).json();
    expect(store.daemons[0].ingressPort).toBe(9119);
    const response = await heartbeat(request(`/api/daemons/${approved.daemon_id}/heartbeat`, { port: 9200 }, credentials.daemon_token), { params: Promise.resolve({ id: approved.daemon_id }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, hostname: approved.hostname, port: 9200 });
    expect(tunnels.ingress).toEqual({ [store.daemons[0].tunnelId]: 9200 });
    expect(store.daemons[0].ingressPort).toBe(9200);
  });
});

describe("health", () => {
  it("reports placeholder backends until production services are configured", async () => {
    const { GET } = await import("@/app/api/health/route");
    expect(await (await GET()).json()).toMatchObject({ ok: true, ready: false, store: "memory", tunnels: "fake", auth: "dev", signing: "ephemeral" });
  });
});

describe("dev user fallback", () => {
  it("is ignored in a production build on any host", async () => {
    const { currentClerkUserId } = await import("@/lib/auth");
    vi.stubEnv("NODE_ENV", "production");
    try { expect(await currentClerkUserId()).toBeNull(); } finally { vi.unstubAllEnvs(); }
    expect(await currentClerkUserId()).toBe("clerk-dev-user");
  });
});

describe("client authorization", () => {
  it("does not create a session while rendering the authorization page", async () => {
    await AuthorizePage({ searchParams: Promise.resolve({ state: "desktop-state", device: "Alex Mac" }) });
    expect(store.clientSessions).toHaveLength(0);
  });

  it("creates one session after explicit authorization", async () => {
    const form = new FormData();
    form.set("state", "desktop-state");
    form.set("device", "Alex Mac");
    const result = await authorizeClient({}, form);
    expect(result.href).toMatch(/^hexbot:\/\/connect\?state=desktop-state#session=hxc_/);
    expect(store.clientSessions).toHaveLength(1);
    expect(store.clientSessions[0].deviceName).toBe("Alex Mac");
  });
});

describe("daemon self-revocation", () => {
  it("lets a daemon revoke itself with its own token, but not another daemon", async () => {
    const first = await registration(); const second = await registration();
    const token = (await (await poll(request("/api/register/poll", { device_code: first.started.device_code }))).json()).daemon_token;
    const other = await remove(request(`/api/daemons/${second.approved.daemon_id}`, undefined, token, "DELETE"), { params: Promise.resolve({ id: second.approved.daemon_id }) });
    expect(other.status).toBe(404);
    const own = await remove(request(`/api/daemons/${first.approved.daemon_id}`, undefined, token, "DELETE"), { params: Promise.resolve({ id: first.approved.daemon_id }) });
    expect(own.status).toBe(200);
    expect(store.daemons.find(d => d.id === first.approved.daemon_id)?.revokedAt).toBeInstanceOf(Date);
    expect((await remove(request(`/api/daemons/${first.approved.daemon_id}`, undefined, "bogus", "DELETE"), { params: Promise.resolve({ id: first.approved.daemon_id }) })).status).toBe(401);
  });
});
