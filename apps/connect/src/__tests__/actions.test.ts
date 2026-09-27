import { beforeEach, describe, expect, it, vi } from "vitest";

// Server actions revalidate the page; outside a request that call has nothing to revalidate.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { MemoryStore } from "@/lib/store";
import { FakeTunnelProvider } from "@/lib/tunnels";
import { setRuntimeForTests } from "@/lib/runtime";
import { hashToken, randomToken } from "@/lib/tokens";
import { renameDaemon, revokeDaemon, revokeSession } from "@/app/connect/actions";
import { POST as start } from "@/app/api/register/start/route";
import { POST as approve } from "@/app/api/register/approve/route";

const request = (path: string, body: unknown) => new Request(`http://localhost${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
let store: MemoryStore; let tunnels: FakeTunnelProvider;
beforeEach(() => { delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY; store = new MemoryStore(); tunnels = new FakeTunnelProvider(); setRuntimeForTests({ store, tunnels }); });

async function ownedBy(user: string) {
  process.env.DEV_USER_ID = user;
  const started = await (await start(request("/api/register/start", { daemon_name: `${user}'s Mac`, platform: "darwin" }))).json();
  const approved = await (await approve(request("/api/register/approve", { user_code: started.user_code }))).json();
  return approved.daemon_id as string;
}

describe("daemons page actions", () => {
  it("only the owner can rename or revoke a daemon", async () => {
    const mine = await ownedBy("alice");
    const theirs = await ownedBy("bob");
    process.env.DEV_USER_ID = "alice";
    expect(await renameDaemon(theirs, "Mine now")).toEqual({ error: "That daemon is not on your account." });
    expect(await revokeDaemon(theirs)).toEqual({ error: "That daemon is not on your account." });
    expect(await renameDaemon(mine, "  Studio Mac  ")).toEqual({ ok: true });
    expect(store.daemons.find(d => d.id === mine)?.name).toBe("Studio Mac");
    expect(store.daemons.find(d => d.id === theirs)?.name).toBe("bob's Mac");
  });
  it("revokes the tunnel before the record, and keeps the daemon listed when the tunnel refuses", async () => {
    const mine = await ownedBy("alice");
    const tunnelId = store.daemons[0].tunnelId;
    tunnels.delete = async () => { throw new Error("cloudflare down"); };
    expect(await revokeDaemon(mine)).toEqual({ error: "The daemon's tunnel could not be deleted. Try again in a moment." });
    expect(store.daemons[0].revokedAt).toBeNull();
    tunnels.delete = async id => { tunnels.deleted.push(id); };
    expect(await revokeDaemon(mine)).toEqual({ ok: true });
    expect(tunnels.deleted).toEqual([tunnelId]);
    expect(store.daemons[0].revokedAt).toBeInstanceOf(Date);
  });
  it("signs out only the caller's own apps", async () => {
    await ownedBy("alice"); await ownedBy("bob");
    const [alice, bob] = store.users;
    const session = await store.createClientSession({ userId: bob.id, tokenHash: hashToken(randomToken("hxc_")), deviceName: "Bob's laptop" });
    process.env.DEV_USER_ID = "alice";
    expect(await revokeSession(session.id)).toEqual({ error: "That device is already signed out." });
    expect(store.clientSessions[0].revokedAt).toBeNull();
    process.env.DEV_USER_ID = "bob";
    expect(await revokeSession(session.id)).toEqual({ ok: true });
    expect(alice.id).not.toBe(bob.id);
  });
});
