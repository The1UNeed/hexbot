import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as enroll } from "@/app/api/daemons/[id]/identity/route";
import { GET as list } from "@/app/api/daemons/route";
import { POST as start } from "@/app/api/register/start/route";
import { POST as approve } from "@/app/api/register/approve/route";
import { POST as poll } from "@/app/api/register/poll/route";
import { identityHost } from "@/lib/daemon-identity";
import { probeOrigin, Reachability } from "@/lib/reachability";
import { setRuntimeForTests } from "@/lib/runtime";
import { MemoryStore } from "@/lib/store";
import { hashToken } from "@/lib/tokens";
import { FakeTunnelProvider } from "@/lib/tunnels";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const key = publicKey.export({ format: "jwk" }).x!;
const other = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!;
const request = (body: unknown, token?: string) => new Request("http://localhost/api", { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
let store: MemoryStore; let tunnels: FakeTunnelProvider;
beforeEach(() => {
  vi.stubEnv("DEV_USER_ID", "identity-test"); vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "");
  store = new MemoryStore(); tunnels = new FakeTunnelProvider(); setRuntimeForTests({ store, tunnels });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function registration() {
  const started = await (await start(request({ daemon_name: "Home", platform: "linux" }))).json();
  expect((await approve(request({ user_code: started.user_code }))).status).toBe(200);
  return started.device_code as string;
}
async function registered() {
  const device_code = await registration();
  const credentials = await (await poll(request({ device_code }))).json();
  return { credentials, daemon: store.daemons[0], context: { params: Promise.resolve({ id: credentials.daemon_id }) } };
}

describe("identity enrollment", () => {
  it("requires both credentials, enrolls once, accepts the same key and refuses a replacement", async () => {
    const { credentials: c, daemon, context } = await registered();
    const body = { public_key: key, tunnel_token: c.tunnel_token };
    expect((await enroll(request(body), context)).status).toBe(401);
    expect((await enroll(request({ ...body, tunnel_token: "forged" }, c.daemon_token), context)).status).toBe(403);
    expect((await enroll(request(body, c.daemon_token), { params: Promise.resolve({ id: "other" }) })).status).toBe(403);
    expect(daemon.identityKey).toBeUndefined();
    expect((await enroll(request(body, c.daemon_token), context)).status).toBe(200);
    expect(daemon.identityKey).toBe(key);
    expect((await enroll(request(body, c.daemon_token), context)).status).toBe(200);
    expect((await enroll(request({ ...body, public_key: other }, c.daemon_token), context)).status).toBe(409);
    expect(daemon.identityKey).toBe(key);
    await store.revokeDaemon(daemon.id, new Date());
    expect((await enroll(request(body, c.daemon_token), context)).status).toBe(410);
  });
  it("allows only one of two different keys and lets revocation during proof verification win", async () => {
    const { credentials: c, daemon, context } = await registered();
    const results = await Promise.all([key, other].map(public_key => enroll(request({ public_key, tunnel_token: c.tunnel_token }, c.daemon_token), context)));
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    const inspect = tunnels.inspect.bind(tunnels);
    vi.spyOn(tunnels, "inspect").mockImplementation(async id => { await store.revokeDaemon(daemon.id, new Date()); return inspect(id); });
    expect((await enroll(request({ public_key: key, tunnel_token: c.tunnel_token }, c.daemon_token), context)).status).toBe(410);
  });
  it("stores the poll key and returns it in the daemon list", async () => {
    const device_code = await registration();
    expect((await poll(request({ device_code, public_key: key }))).status).toBe(200);
    expect(store.daemons[0].identityKey).toBe(key);
    await store.createClientSession({ userId: store.users[0].id, tokenHash: hashToken("client"), deviceName: "App" });
    const response = await list(new Request("http://localhost/api/daemons", { headers: { Authorization: "Bearer client" } }));
    expect((await response.json()).daemons[0].identity_key).toBe(key);
  });
  it("still registers and lists daemons when the identity column has not been migrated", async () => {
    const device_code = await registration();
    vi.spyOn(store, "enrollDaemonIdentity").mockRejectedValue(new Error('column "identity_key" does not exist'));
    const response = await poll(request({ device_code, public_key: key }));
    expect(response.status).toBe(200);
    const c = await response.json();
    expect(c.status).toBe("approved");
    expect(store.daemons[0].tokenHash).toBe(hashToken(c.daemon_token));
    await store.createClientSession({ userId: store.users[0].id, tokenHash: hashToken("client"), deviceName: "App" });
    expect((await (await list(new Request("http://localhost/api/daemons", { headers: { Authorization: "Bearer client" } }))).json()).daemons[0].identity_key).toBeNull();
    expect((await enroll(request({ public_key: key, tunnel_token: c.tunnel_token }, c.daemon_token), { params: Promise.resolve({ id: c.daemon_id }) })).status).toBe(503);
  });
});

describe("signed reachability", () => {
  it("normalizes Host in the same way as the daemon", () => {
    expect(identityHost("https://OWL.example.:443")).toBe("owl.example");
    expect(identityHost("http://localhost:9119")).toBe("localhost:9119");
    expect(identityHost("http://[::1]:9119")).toBe("[::1]:9119");
  });
  const daemon = { id: "daemon-1", identityKey: key, tunnelHostname: "owl.example", ingressPort: 9119, lastSeenAt: new Date() };
  function answer(mode: string) {
    return vi.fn(async (input: string) => {
      const url = new URL(input); const nonce = url.searchParams.get("nonce");
      const id = mode === "wrong daemon" ? "other" : daemon.id;
      const message = `hexbot-identity-v1\n${id}\n${mode === "wrong host" ? "other.example" : url.host}\n${nonce}`;
      return Response.json({ daemon_id: id, public_key: key, signature: mode === "invalid" ? Buffer.alloc(64).toString("base64url") : sign(null, Buffer.from(message), privateKey).toString("base64url") });
    });
  }
  it.each(["valid", "invalid", "wrong daemon", "wrong host"])("checks %s signatures", async mode => {
    const fetcher = answer(mode); vi.stubGlobal("fetch", fetcher);
    const reachability = new Reachability(probeOrigin);
    expect((await reachability.statuses([daemon], false)).get(daemon.id)).toBe(mode === "valid" ? "online" : "unreachable");
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/api/connect/identity?nonce="), expect.objectContaining({ redirect: "manual", credentials: "omit" }));
  });
  it("keeps the cache TTL but probes again when a key is enrolled, with a fresh nonce", async () => {
    const fetcher = answer("valid"); vi.stubGlobal("fetch", fetcher);
    const reachability = new Reachability(probeOrigin); const now = Date.now();
    await reachability.statuses([{ ...daemon, identityKey: null }], false, now);
    expect(fetcher.mock.calls[0][0]).toContain("/api/auth/providers");
    await reachability.statuses([daemon], false, now);
    await reachability.statuses([daemon], false, now + 1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await reachability.statuses([daemon], false, now + 31_000);
    expect(fetcher.mock.calls[1][0]).not.toBe(fetcher.mock.calls[2][0]);
  });
  it("uses providers without a key and never falls back after an identity failure", async () => {
    const fetcher = vi.fn(async () => Response.json({ providers: [] })); vi.stubGlobal("fetch", fetcher);
    expect(await probeOrigin("https://owl.example", { id: daemon.id })).toBe(true);
    expect(await probeOrigin("https://owl.example", daemon)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
