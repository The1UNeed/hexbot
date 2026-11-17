import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "@/lib/store";
import { FakeTunnelProvider, type TunnelProvider } from "@/lib/tunnels";
import { setRuntimeForTests } from "@/lib/runtime";
import { GET } from "@/app/oauth/google/route";

let store: MemoryStore;
const daemon = (tunnelHostname: string) => store.createDaemon({ userId: "u", name: "Home", slug: tunnelHostname.split(".")[0], tunnelId: "t", tunnelHostname, ingressPort: 9200, tokenHash: `h-${tunnelHostname}` });
const back = (query: string) => GET(new Request(`https://connect.hexbot.app/oauth/google?${query}`));
const cloudflare = { kind: "cloudflare" } as unknown as TunnelProvider;

beforeEach(() => { store = new MemoryStore(); setRuntimeForTests({ store, tunnels: cloudflare }); });

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
