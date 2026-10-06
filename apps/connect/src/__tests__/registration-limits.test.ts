import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/register/start/route";
import { registrationClientHash } from "@/lib/registration-client";
import { setRuntimeForTests } from "@/lib/runtime";
import { MemoryStore, REGISTRATION_ATTEMPTS_PER_MINUTE } from "@/lib/store";
import { FakeTunnelProvider } from "@/lib/tunnels";

const request = (ip = "203.0.113.1") => new Request("http://localhost/api/register/start", {
  method: "POST", headers: { "content-type": "application/json", "x-vercel-forwarded-for": ip, "x-real-ip": ip },
  body: JSON.stringify({ daemon_name: "Home", platform: "linux" })
});

beforeEach(() => { vi.stubEnv("VERCEL", "1"); vi.stubEnv("CONNECT_TRUST_PROXY", ""); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("registration limits", () => {
  it("caps concurrent starts in the shared store and rejects before lookup or insertion", async () => {
    const store = new MemoryStore();
    setRuntimeForTests({ store, tunnels: new FakeTunnelProvider() });
    const results = await Promise.all(Array.from({ length: 30 }, () => POST(request())));
    expect(results.filter(result => result.status === 200)).toHaveLength(REGISTRATION_ATTEMPTS_PER_MINUTE);
    expect(results.filter(result => result.status === 429)).toHaveLength(20);
    expect(store.registrations).toHaveLength(REGISTRATION_ATTEMPTS_PER_MINUTE);
    const lookup = vi.spyOn(store, "findRegistrationByUserCode"), insert = vi.spyOn(store, "createRegistration");
    // A new route/runtime instance retains the same shared limit.
    setRuntimeForTests({ store, tunnels: new FakeTunnelProvider() });
    const denied = await POST(request());
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(lookup).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
    expect((await POST(request("203.0.113.2"))).status).toBe(200);
  });

  it("recovers in the next minute and never resets on an older clock", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    const store = new MemoryStore();
    const window = new Date();
    for (let i = 0; i < REGISTRATION_ATTEMPTS_PER_MINUTE; i++) expect(await store.claimRegistrationAttempt("client", window)).toBe(true);
    expect(await store.claimRegistrationAttempt("client", window)).toBe(false);
    expect(await store.claimRegistrationAttempt("client", new Date(window.getTime() - 60_000))).toBe(false);
    expect(await store.claimRegistrationAttempt("client", new Date(window.getTime() + 60_000))).toBe(true);
  });
});

describe("registration client identity", () => {
  it("ignores spoofable headers without a trusted proxy and hashes addresses", () => {
    vi.stubEnv("VERCEL", "");
    expect(registrationClientHash(request("203.0.113.1"))).toBe(registrationClientHash(request("203.0.113.2")));
    vi.stubEnv("CONNECT_TRUST_PROXY", "1");
    expect(registrationClientHash(request())).toMatch(/^[a-f0-9]{64}$/);
    expect(registrationClientHash(request("203.0.113.1"))).not.toBe(registrationClientHash(request("203.0.113.2")));
    expect(registrationClientHash(request("malformed"))).toBe(registrationClientHash(request("")));
    expect(registrationClientHash(request("fe80::1%eth0"))).toBe(registrationClientHash(request("")));
  });

  it("normalizes IPv6 and groups /64 addresses while separating IPv4-mapped clients", () => {
    expect(registrationClientHash(request("2001:db8:abcd:1::1"))).toBe(registrationClientHash(request("2001:0db8:abcd:0001:0000:0000:0000:ffff")));
    expect(registrationClientHash(request("2001:db8:abcd:1::1"))).not.toBe(registrationClientHash(request("2001:db8:abcd:2::1")));
    expect(registrationClientHash(request("::ffff:203.0.113.1"))).not.toBe(registrationClientHash(request("::ffff:203.0.113.2")));
  });
});
