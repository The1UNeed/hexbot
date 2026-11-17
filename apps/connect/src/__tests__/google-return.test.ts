import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "@/lib/store";
import { FakeTunnelProvider, type TunnelProvider } from "@/lib/tunnels";
import { setRuntimeForTests } from "@/lib/runtime";
import { GET } from "@/app/oauth/google/route";
import { localPath } from "@/lib/auth";

let store: MemoryStore;
let owner: string;
const daemon = (tunnelHostname: string, userId = owner) => store.createDaemon({ userId, name: "Home", slug: tunnelHostname.split(".")[0], tunnelId: "t", tunnelHostname, ingressPort: 9200, tokenHash: `h-${tunnelHostname}` });
const back = (query: string) => GET(new Request(`https://connect.hexbot.app/oauth/google?${query}`));
const cloudflare = { kind: "cloudflare" } as unknown as TunnelProvider;

beforeEach(async () => {
  store = new MemoryStore();
  setRuntimeForTests({ store, tunnels: cloudflare });
  vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "");
  vi.stubEnv("DEV_USER_ID", "clerk_owner");
  owner = (await store.getOrCreateUser("clerk_owner")).id;
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("Google's return from a daemon's sign-in", () => {
  it("goes on to the daemon named in the state, with the query unchanged and nothing cached", async () => {
    const row = await daemon("amber-otter-1234.hexbot.app");
    const query = `state=${row.id}.abc&code=4%2F0A-x&scope=email%20openid`;
    const response = await back(query);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`https://amber-otter-1234.hexbot.app/oauth/google?${query}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    // A declined sign-in still names its state, so the daemon ends the right one.
    expect((await back(`error=access_denied&state=${row.id}.abc`)).headers.get("location")).toContain("error=access_denied");
  });

  it("uses the daemon's own port with development tunnels", async () => {
    setRuntimeForTests({ store, tunnels: new FakeTunnelProvider() });
    const row = await daemon("amber-otter-1234.hexbot.app");
    expect((await back(`state=${row.id}.abc&code=c`)).headers.get("location")).toBe(`http://127.0.0.1:9200/oauth/google?state=${row.id}.abc&code=c`);
  });

  it("goes on only for the daemon's own Connect account, and asks a signed-out browser to sign in first", async () => {
    const row = await daemon("amber-otter-1234.hexbot.app");
    const query = `state=${row.id}.abc&code=c`;

    // Signed out: Google's answer waits in a cookie only this address reads, not in the sign-in page's address.
    vi.stubEnv("DEV_USER_ID", "");
    const signedOut = await back(query);
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toBe("https://connect.hexbot.app/sign-in?redirect_url=%2Foauth%2Fgoogle");
    const set = signedOut.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/^hexbot_google_return=[^;]+; Path=\/oauth\/google; Max-Age=900; HttpOnly; SameSite=Lax; Secure$/);

    // Signed in, back at the bare address: it goes on with the answer it held, and forgets it.
    vi.stubEnv("DEV_USER_ID", "clerk_owner");
    const resumed = await GET(new Request("https://connect.hexbot.app/oauth/google", { headers: { cookie: `other=1; ${set.split(";")[0]}` } }));
    expect(resumed.status).toBe(303);
    expect(resumed.headers.get("location")).toBe(`https://amber-otter-1234.hexbot.app/oauth/google?${query}`);
    expect(resumed.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(localPath("/oauth/google")).toBe("/oauth/google");
    expect(localPath("/connect?x=1#y")).toBe("/connect?x=1#y");
    for (const elsewhere of ["https://evil.example/", "//evil.example/", "/\\evil.example", "/\t/evil.example", "/\n/evil.example", "\t//evil.example", undefined, ["/a", "/b"]]) expect(localPath(elsewhere)).toBeNull();

    // Someone who sent another person the consent page for their own daemon gets nothing.
    vi.stubEnv("DEV_USER_ID", "clerk_owner");
    const theirs = await daemon("amber-otter-5678.hexbot.app", (await store.getOrCreateUser("clerk_other")).id);
    const refused = await back(`state=${theirs.id}.abc&code=c`);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("location")).toBeNull();
    expect(await refused.text()).toContain("belongs to another Hex Connect account");
  });

  it("refuses a state that names no daemon, or one removed from Connect", async () => {
    for (const query of ["code=c", "state=abc&code=c", `state=00000000-0000-4000-8000-000000000000.abc&code=c`]) {
      const response = await back(query);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers.get("location")).toBeNull();
    }
    const row = await daemon("amber-otter-1234.hexbot.app");
    await store.revokeDaemon(row.id, new Date());
    const response = await back(`state=${row.id}.abc&code=c`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("no longer on Hex Connect");
  });
});
