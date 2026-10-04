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
import { GET as listDaemons } from "@/app/api/daemons/route";
import { POST as tunnelRepair } from "@/app/api/daemons/[id]/tunnel/route";
import { Reachability } from "@/lib/reachability";
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
  it("starts, approves, returns credentials once, then reports consumption", async () => { const { started } = await registration(); const firstResponse = await poll(request("/api/register/poll", { device_code: started.device_code })); expect(firstResponse.status).toBe(200); const first = await firstResponse.json(); expect(first).toMatchObject({ status: "approved", slug: expect.any(String), daemon_token: expect.stringMatching(/^hxd_/), tunnel_token: expect.stringMatching(/^fake-tunnel-token-/) }); expect(first).toMatchObject({ owner_id: store.users[0].id, issuer: "https://connect.hexbot.app", keys: [expect.objectContaining({ kty: "EC", crv: "P-256" })] }); expect(store.daemons[0].tokenHash).toBe(hashToken(first.daemon_token)); expect(JSON.stringify(store)).not.toContain(first.daemon_token); expect(JSON.stringify(store)).not.toContain(first.tunnel_token); const second = await poll(request("/api/register/poll", { device_code: started.device_code })); expect(second.status).toBe(410); expect((await second.json()).error).toBe("consumed"); });
});

describe("registration of a daemon revoked before it polls", () => {
  it("reports denied and hands out no credentials", async () => { const { started } = await registration(); store.daemons[0].revokedAt = new Date(); expect(await (await poll(request("/api/register/poll", { device_code: started.device_code }))).json()).toEqual({ status: "denied" }); });
});

describe("authenticated daemon routes", () => {
  it("requires a client session before issuing a grant", async () => { const { approved } = await registration(); const denied = await grant(request(`/api/daemons/${approved.daemon_id}/grant`), { params: Promise.resolve({ id: approved.daemon_id }) }); expect(denied.status).toBe(401); const user = store.users[0]; const clientToken = randomToken("hxc_"); await store.createClientSession({ userId: user.id, tokenHash: hashToken(clientToken), deviceName: "Laptop" }); const allowed = await grant(request(`/api/daemons/${approved.daemon_id}/grant`, undefined, clientToken), { params: Promise.resolve({ id: approved.daemon_id }) }); expect(allowed.status).toBe(200); const body = await allowed.json(); expect(body.grant.split(".")).toHaveLength(3); expect(body.daemon).toMatchObject({ host: "127.0.0.1", port: 9119, tls: false }); });
  it("updates last_seen_at on heartbeat", async () => { const { started, approved } = await registration(); const polled = await poll(request("/api/register/poll", { device_code: started.device_code })); const credentials = await polled.json(); const response = await heartbeat(request(`/api/daemons/${approved.daemon_id}/heartbeat`, { port: 8000 }, credentials.daemon_token), { params: Promise.resolve({ id: approved.daemon_id }) }); expect(response.status).toBe(200); expect(store.daemons[0].lastSeenAt).toBeInstanceOf(Date); });
  it("revokes the daemon and deletes its tunnel", async () => { const { approved } = await registration(); const user = store.users[0]; const clientToken = randomToken("hxc_"); await store.createClientSession({ userId: user.id, tokenHash: hashToken(clientToken), deviceName: "Laptop" }); const response = await remove(request(`/api/daemons/${approved.daemon_id}`, undefined, clientToken, "DELETE"), { params: Promise.resolve({ id: approved.daemon_id }) }); expect(response.status).toBe(200); expect(store.daemons[0].revokedAt).toBeInstanceOf(Date); expect(tunnels.deleted).toEqual([store.daemons[0].tunnelId]); });
});

describe("daemon list online state", () => {
  it("reports online only when the address answers, keeps the boolean for older apps, and never probes an offline daemon", async () => {
    const probed: string[] = [];
    setRuntimeForTests({ store, tunnels, reachability: new Reachability(async origin => { probed.push(origin); return origin === "http://127.0.0.1:9200"; }) });
    const answering = await registration(); const silent = await registration(); const offline = await registration();
    for (const [entry, port] of [[answering, 9200], [silent, 9201]] as const) {
      const token = (await (await poll(request("/api/register/poll", { device_code: entry.started.device_code }))).json()).daemon_token;
      expect((await heartbeat(request(`/api/daemons/${entry.approved.daemon_id}/heartbeat`, { port }, token), { params: Promise.resolve({ id: entry.approved.daemon_id }) })).status).toBe(200);
    }
    const clientToken = randomToken("hxc_"); await store.createClientSession({ userId: store.users[0].id, tokenHash: hashToken(clientToken), deviceName: "Laptop" });
    const response = await listDaemons(request("/api/daemons", undefined, clientToken, "GET"));
    expect(response.status).toBe(200);
    const byId = Object.fromEntries((await response.json()).daemons.map((d: { id: string }) => [d.id, d]));
    expect(byId[answering.approved.daemon_id]).toMatchObject({ online: true, status: "online" });
    expect(byId[silent.approved.daemon_id]).toMatchObject({ online: false, status: "unreachable" });
    expect(byId[offline.approved.daemon_id]).toMatchObject({ online: false, status: "offline", last_seen_at: null });
    expect(probed.sort()).toEqual(["http://127.0.0.1:9200", "http://127.0.0.1:9201"]);
  });
});

describe("tunnel hostnames and ports", () => {
  it("places daemons one label under the zone and records the heartbeat port without touching the tunnel", async () => {
    process.env.CONNECT_DOMAIN = "hexbot-tunnels.test";
    const { started, approved } = await registration();
    expect(approved.hostname).toMatch(/^[0-9a-f]{16}\.hexbot-tunnels\.test$/);
    const credentials = await (await poll(request("/api/register/poll", { device_code: started.device_code }))).json();
    expect(store.daemons[0].ingressPort).toBe(9119);
    const response = await heartbeat(request(`/api/daemons/${approved.daemon_id}/heartbeat`, { port: 9200 }, credentials.daemon_token), { params: Promise.resolve({ id: approved.daemon_id }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, hostname: approved.hostname, port: 9200 });
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

describe("revoked daemon", () => {
  it("answers 410 daemon_revoked to the revoked daemon's own token, and 401 to an unknown one", async () => {
    const { started, approved } = await registration();
    const token = (await (await poll(request("/api/register/poll", { device_code: started.device_code }))).json()).daemon_token;
    const params = { params: Promise.resolve({ id: approved.daemon_id }) };
    expect((await heartbeat(request(`/api/daemons/${approved.daemon_id}/heartbeat`, { port: 9119 }, token), params)).status).toBe(200);
    await store.revokeDaemon(approved.daemon_id, new Date());
    const revoked = await heartbeat(request(`/api/daemons/${approved.daemon_id}/heartbeat`, { port: 9119 }, token), params);
    expect(revoked.status).toBe(410);
    expect((await revoked.json()).error).toBe("daemon_revoked");
    expect((await remove(request(`/api/daemons/${approved.daemon_id}`, undefined, token, "DELETE"), params)).status).toBe(410);
    const unknown = await heartbeat(request(`/api/daemons/${approved.daemon_id}/heartbeat`, { port: 9119 }, "hxd_unknown"), params);
    expect(unknown.status).toBe(401);
    expect((await unknown.json()).error).toBe("unauthorized");
  });
});

describe("tunnel repair", () => {
  async function registeredDaemon() {
    const { started, approved } = await registration();
    const token = (await (await poll(request("/api/register/poll", { device_code: started.device_code }))).json()).daemon_token as string;
    const daemon = store.daemons.find(d => d.id === approved.daemon_id)!;
    return { daemon, token, params: { params: Promise.resolve({ id: daemon.id }) } };
  }
  const repair = (id: string, token: string, body?: unknown) => tunnelRepair(request(`/api/daemons/${id}/tunnel`, body, token), { params: Promise.resolve({ id }) });
  const revokeViaApi = async (id: string) => {
    const clientToken = randomToken("hxc_"); await store.createClientSession({ userId: store.users[0].id, tokenHash: hashToken(clientToken), deviceName: "Laptop" });
    expect((await remove(request(`/api/daemons/${id}`, undefined, clientToken, "DELETE"), { params: Promise.resolve({ id }) })).status).toBe(200);
  };
  const nothingLive = (hostname: string) => {
    expect([...tunnels.tunnels.values()].every(tunnel => tunnel.deletedAt)).toBe(true);
    expect(tunnels.hostnames.get(hostname)).toBeUndefined();
  };

  it("re-points the hostname at a tunnel that still exists and hands out no token, ignoring any body", async () => {
    const { daemon, token } = await registeredDaemon();
    const before = daemon.tunnelId;
    tunnels.hostnames.set(daemon.tunnelHostname, "somewhere-else");
    const response = await repair(daemon.id, token, { ingress: "https://evil.test" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tunnel_hostname: daemon.tunnelHostname, replaced: false });
    expect(daemon.tunnelId).toBe(before);
    expect(tunnels.hostnames.get(daemon.tunnelHostname)).toBe(before);
    expect(tunnels.tunnels.size).toBe(1);
    expect(tunnels.deleted).toEqual([]);
  });
  it("replaces a deleted tunnel under the same hostname, returns its token, and drops the old one", async () => {
    const { daemon, token } = await registeredDaemon();
    const old = daemon.tunnelId; tunnels.tunnels.get(old)!.deletedAt = new Date();
    const response = await repair(daemon.id, token);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tunnel_hostname).toBe(daemon.tunnelHostname);
    expect(body.replaced).toBe(true);
    expect(daemon.tunnelId).not.toBe(old);
    expect(body.tunnel_token).toBe(`fake-tunnel-token-${daemon.tunnelId}`);
    expect(tunnels.hostnames.get(daemon.tunnelHostname)).toBe(daemon.tunnelId);
    expect(tunnels.deleted).toEqual([old]);
  });
  it("treats a tunnel Cloudflare no longer knows the same way", async () => {
    const { daemon, token } = await registeredDaemon();
    const old = daemon.tunnelId; tunnels.tunnels.delete(old);
    expect((await repair(daemon.id, token)).status).toBe(200);
    expect(daemon.tunnelId).not.toBe(old);
    expect(tunnels.hostnames.get(daemon.tunnelHostname)).toBe(daemon.tunnelId);
  });
  it("allows one repair per two minutes per daemon, claimed before any tunnel work", async () => {
    const { daemon, token } = await registeredDaemon();
    expect((await repair(daemon.id, token)).status).toBe(200);
    tunnels.tunnels.get(daemon.tunnelId)!.deletedAt = new Date();
    const response = await repair(daemon.id, token);
    expect(response.status).toBe(429);
    expect((await response.json()).error).toBe("tunnel_recent");
    expect(tunnels.tunnels.size).toBe(1);
  });
  it("lets the first of two concurrent repairs win, and the loser points the hostname at the winner's tunnel before handing it out", async () => {
    const { daemon, token } = await registeredDaemon();
    const old = daemon.tunnelId; tunnels.tunnels.get(old)!.deletedAt = new Date();
    const create = tunnels.createTunnel.bind(tunnels);
    let mine = ""; let rival = "";
    tunnels.createTunnel = async name => { const created = await create(name); mine = created.tunnelId; rival = (await create("rival")).tunnelId; expect(await store.swapDaemonTunnel(daemon.id, old, rival)).toBe(true); return created; };
    const response = await repair(daemon.id, token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tunnel_token: `fake-tunnel-token-${rival}`, tunnel_hostname: daemon.tunnelHostname, replaced: true });
    expect(daemon.tunnelId).toBe(rival);
    expect(tunnels.deleted).toEqual([mine]);
    expect(tunnels.hostnames.get(daemon.tunnelHostname)).toBe(rival);
  });
  it("answers 410 to a revoked daemon and 403 to another daemon's token", async () => {
    const first = await registeredDaemon(); const second = await registeredDaemon();
    expect((await repair(second.daemon.id, first.token)).status).toBe(403);
    await store.revokeDaemon(first.daemon.id, new Date());
    expect((await repair(first.daemon.id, first.token)).status).toBe(410);
    expect(await store.swapDaemonTunnel(first.daemon.id, first.daemon.tunnelId, "anything")).toBe(false);
  });
  it("lets a revoke that lands after the repair passed auth win: nothing of the repair survives", async () => {
    const { daemon, token } = await registeredDaemon();
    const hostname = daemon.tunnelHostname; const old = daemon.tunnelId;
    const inspect = tunnels.inspect.bind(tunnels);
    tunnels.inspect = async id => { await revokeViaApi(daemon.id); return inspect(id); };
    const response = await repair(daemon.id, token);
    expect(response.status).toBe(410);
    expect((await response.json()).error).toBe("daemon_revoked");
    expect(daemon.revokedAt).toBeInstanceOf(Date);
    expect(daemon.tunnelId).toBe(old);
    nothingLive(hostname);
  });
  it("lets a revoke that lands after the swap win too", async () => {
    const { daemon, token } = await registeredDaemon();
    const hostname = daemon.tunnelHostname;
    tunnels.tunnels.get(daemon.tunnelId)!.deletedAt = new Date();
    const point = tunnels.pointHostname.bind(tunnels);
    let revoked = false;
    tunnels.pointHostname = async (host, id) => { await point(host, id); if (!revoked) { revoked = true; await revokeViaApi(daemon.id); } };
    const response = await repair(daemon.id, token);
    expect(response.status).toBe(410);
    expect(daemon.revokedAt).toBeInstanceOf(Date);
    nothingLive(hostname);
  });
  it("re-points a surviving hostname when a revoke lands after an existing tunnel was re-pointed", async () => {
    const { daemon, token } = await registeredDaemon();
    const hostname = daemon.tunnelHostname;
    const point = tunnels.pointHostname.bind(tunnels);
    tunnels.pointHostname = async (host, id) => { await point(host, id); await revokeViaApi(daemon.id); };
    expect((await repair(daemon.id, token)).status).toBe(410);
    nothingLive(hostname);
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
