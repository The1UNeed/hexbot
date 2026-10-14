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
  it("sends Expo Connect's own words, the section and the device, never the message", async () => {
    const send = vi.fn(async () => new Response(JSON.stringify({ data: [{ status: "ok" }, { status: "error", details: { error: "DeviceNotRegistered" } }, { status: "error", details: { error: "InvalidCredentials" } }] })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await sendCheckinPush({ targets: [{ token: phone, device: "d1" }, { token: "ExpoPushToken[old]", device: "d2" }, { token: "ExpoPushToken[bad]", device: "d3" }], section: "s1" }, send as typeof fetch);
    warn.mockRestore();
    expect(result).toEqual({ gone: ["ExpoPushToken[old]"], failed: 1 });
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(EXPO_PUSH_URL);
    expect(JSON.parse(String(init.body))[0]).toEqual(expect.objectContaining({ to: phone, title: "Hexbot", body: "Your primary bot has a message for you.", data: { section: "s1", device: "d1" } }));
  });

  it("refuses another daemon's id, an unknown token, and anything but Expo tokens", async () => {
    const id = store.daemons[0].id;
    const ok = { targets: [{ token: phone, device: "d1" }], section: "s1" };
    expect((await call("someone-else", ok)).status).toBe(403);
    expect((await call(id, ok, "hxd_unknown")).status).toBe(401);
    for (const body of [
      { targets: [{ token: "https://evil.example/hook", device: "d1" }], section: "s1" },
      { targets: [{ token: phone, device: "d1" }], section: "../s1" },
      { targets: [{ token: phone, device: "d1", title: "Pay now" }], section: "s1" },
      { ...ok, bot: "Your bank" },
      { ...ok, message: "chat text" },
    ]) expect((await call(id, body)).status).toBe(400);
  });

  it("limits each daemon to a few pushes a minute", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ data: [{ status: "ok" }] })));
    const id = store.daemons[0].id;
    const ok = { targets: [{ token: phone, device: "d1" }], section: "s1" };
    for (let i = 0; i < PUSHES_PER_MINUTE; i++) expect((await call(id, ok)).status).toBe(200);
    const limited = await call(id, ok);
    fetchMock.mockRestore();
    expect(limited.status).toBe(429);
  });
});
