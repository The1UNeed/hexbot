import { beforeEach, describe, expect, it } from "vitest";
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
  it("requires a client session before issuing a grant", async () => { const { approved } = await registration(); const denied = await grant(request(`/api/daemons/${approved.daemon_id}/grant`), { params: Promise.resolve({ id: approved.daemon_id }) }); expect(denied.status).toBe(401); const user = store.users[0]; const clientToken = randomToken("hxc_"); await store.createClientSession({ userId: user.id, tokenHash: hashToken(clientToken), deviceName: "Laptop" }); const allowed = await grant(request(`/api/daemons/${approved.daemon_id}/grant`, undefined, clientToken), { params: Promise.resolve({ id: approved.daemon_id }) }); expect(allowed.status).toBe(200); expect((await allowed.json()).grant.split(".")).toHaveLength(3); });
  it("updates last_seen_at on heartbeat", async () => { const { started, approved } = await registration(); const polled = await poll(request("/api/register/poll", { device_code: started.device_code })); const credentials = await polled.json(); const response = await heartbeat(request(`/api/daemons/${approved.daemon_id}/heartbeat`, { port: 8000 }, credentials.daemon_token), { params: Promise.resolve({ id: approved.daemon_id }) }); expect(response.status).toBe(200); expect(store.daemons[0].lastSeenAt).toBeInstanceOf(Date); });
  it("revokes the daemon and deletes its tunnel", async () => { const { approved } = await registration(); const user = store.users[0]; const clientToken = randomToken("hxc_"); await store.createClientSession({ userId: user.id, tokenHash: hashToken(clientToken), deviceName: "Laptop" }); const response = await remove(request(`/api/daemons/${approved.daemon_id}`, undefined, clientToken, "DELETE"), { params: Promise.resolve({ id: approved.daemon_id }) }); expect(response.status).toBe(200); expect(store.daemons[0].revokedAt).toBeInstanceOf(Date); expect(tunnels.deleted).toEqual([store.daemons[0].tunnelId]); });
});
