import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "@/lib/store";
import { FakeTunnelProvider } from "@/lib/tunnels";
import { setRuntimeForTests } from "@/lib/runtime";
import { hashToken } from "@/lib/tokens";
import { EXPO_PUSH_URL, PUSHES_PER_MINUTE, sendCheckinPush } from "@/lib/push";
import { POST as push } from "@/app/api/daemons/[id]/push/route";

let store: MemoryStore;
const TOKEN = "hxd_daemon_token";
const phone = "ExponentPushToken[phone-1]";
beforeEach(async () => {
  store = new MemoryStore();
  setRuntimeForTests({ store, tunnels: new FakeTunnelProvider() });
  const user = await store.getOrCreateUser("clerk-user");
  await store.createDaemon({ userId: user.id, name: "Mac", slug: "mac", tunnelId: "t", tunnelHostname: "mac.example", ingressPort: 9119, tokenHash: hashToken(TOKEN) });
});
const call = (id: string, body: unknown, token = TOKEN) => push(new Request(`http://connect.test/api/daemons/${id}/push`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

describe("check-in push", () => {
  it("sends Expo the bot's name and the section, never the message", async () => {
    const send = vi.fn(async () => new Response(JSON.stringify({ data: [{ status: "ok" }, { status: "error", details: { error: "DeviceNotRegistered" } }] })));
    const gone = await sendCheckinPush({ tokens: [phone, "ExpoPushToken[old]"], bot: "HexBot", section: "s1" }, send as typeof fetch);
    expect(gone).toEqual(["ExpoPushToken[old]"]);
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(EXPO_PUSH_URL);
    expect(JSON.parse(String(init.body))).toEqual([
      expect.objectContaining({ to: phone, title: "HexBot", body: "Messaged you from a check-in", data: { section: "s1" } }),
      expect.objectContaining({ to: "ExpoPushToken[old]" }),
    ]);
  });

  it("refuses another daemon's id, an unknown token, and anything but Expo tokens", async () => {
    const id = store.daemons[0].id;
    expect((await call("someone-else", { tokens: [phone], bot: "HexBot", section: "s1" })).status).toBe(403);
    expect((await call(id, { tokens: [phone], bot: "HexBot", section: "s1" }, "hxd_unknown")).status).toBe(401);
    for (const body of [
      { tokens: ["https://evil.example/hook"], bot: "HexBot", section: "s1" },
      { tokens: [phone], bot: "Hex\u0007Bot", section: "s1" },
      { tokens: [phone], bot: "HexBot", section: "../s1" },
      { tokens: [phone], bot: "HexBot", section: "s1", message: "chat text" },
    ]) expect((await call(id, body)).status).toBe(400);
  });

  it("limits each daemon to a few pushes a minute", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ data: [{ status: "ok" }] })));
    const id = store.daemons[0].id;
    for (let i = 0; i < PUSHES_PER_MINUTE; i++) expect((await call(id, { tokens: [phone], bot: "HexBot", section: "s1" })).status).toBe(200);
    const limited = await call(id, { tokens: [phone], bot: "HexBot", section: "s1" });
    fetchMock.mockRestore();
    expect(limited.status).toBe(429);
  });
});
