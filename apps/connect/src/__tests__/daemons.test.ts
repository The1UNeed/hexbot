import { afterEach, describe, expect, it, vi } from "vitest";
import { createTunnelProvider } from "@/lib/tunnels";
import { browserSignInUrl, daemonOrigin, daemonTarget, deviceNameFromUserAgent, relativeTime } from "@/lib/daemons";
import { Reachability, heartbeatFresh } from "@/lib/reachability";

const daemon = { tunnelHostname: "amber-otter-1234.hexbot.app", ingressPort: 9200 };
describe("daemon addresses", () => {
  it("uses the tunnel hostname over TLS, or the loopback port with fake tunnels", () => {
    expect(daemonOrigin(daemon, false)).toBe("https://amber-otter-1234.hexbot.app");
    expect(daemonOrigin(daemon, true)).toBe("http://127.0.0.1:9200");
    expect(daemonTarget(daemon, false)).toEqual({ host: "amber-otter-1234.hexbot.app", port: 443, tls: true });
    expect(daemonTarget(daemon, true)).toEqual({ host: "127.0.0.1", port: 9200, tls: false });
    expect(browserSignInUrl(daemonOrigin(daemon, false))).toBe("https://amber-otter-1234.hexbot.app/auth/login?provider=connect&next=%2F");
  });
  it("counts a heartbeat as fresh for ten minutes", () => {
    const now = Date.now();
    expect(heartbeatFresh({ lastSeenAt: new Date(now - 9 * 60_000) }, now)).toBe(true);
    expect(heartbeatFresh({ lastSeenAt: new Date(now - 11 * 60_000) }, now)).toBe(false);
    expect(heartbeatFresh({ lastSeenAt: null }, now)).toBe(false);
  });
});

describe("online state", () => {
  const now = Date.now();
  const fresh = new Date(now - 60_000);
  const rows = [
    { id: "answers", tunnelHostname: "answers.hexbot.test", ingressPort: 9200, lastSeenAt: fresh },
    { id: "silent", tunnelHostname: "silent.hexbot.test", ingressPort: 9201, lastSeenAt: fresh },
    { id: "gone", tunnelHostname: "gone.hexbot.test", ingressPort: 9202, lastSeenAt: new Date(now - 11 * 60_000) },
  ];
  it("is online only when the address answers, unreachable when the daemon heartbeats but the tunnel is down, and skips probing offline daemons", async () => {
    const probed: string[] = [];
    const reachability = new Reachability(async origin => { probed.push(origin); return origin.startsWith("https://answers."); });
    const statuses = await reachability.statuses(rows, false, now);
    expect(statuses.get("answers")).toBe("online");
    expect(statuses.get("silent")).toBe("unreachable");
    expect(statuses.get("gone")).toBe("offline");
    expect(probed.sort()).toEqual(["https://answers.hexbot.test", "https://silent.hexbot.test"]);
  });
  it("probes the loopback address with fake tunnels and treats a failing probe as not reachable", async () => {
    const probed: string[] = [];
    const reachability = new Reachability(async origin => { probed.push(origin); throw new Error("boom"); });
    expect((await reachability.statuses(rows.slice(0, 1), true, now)).get("answers")).toBe("unreachable");
    expect(probed).toEqual(["http://127.0.0.1:9200"]);
  });
  it("remembers an answer briefly, then asks again", async () => {
    let calls = 0;
    const reachability = new Reachability(async () => { calls += 1; return true; }, 30_000);
    await reachability.statuses(rows.slice(0, 1), false, now);
    await reachability.statuses(rows.slice(0, 1), false, now + 10_000);
    expect(calls).toBe(1);
    await reachability.statuses(rows.slice(0, 1), false, now + 31_000);
    expect(calls).toBe(2);
  });
});

describe("device names", () => {
  it("names a browser session by browser and platform", () => {
    expect(deviceNameFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")).toBe("Chrome on macOS");
    expect(deviceNameFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iPhone");
    expect(deviceNameFromUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0")).toBe("Firefox on Linux");
    expect(deviceNameFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0")).toBe("Edge on Windows");
    expect(deviceNameFromUserAgent(null)).toBe("Browser");
  });
  it("describes when a daemon was last seen", () => {
    const now = Date.now();
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime(new Date(now - 20_000), now)).toBe("just now");
    expect(relativeTime(new Date(now - 5 * 60_000), now)).toBe("5 min ago");
    expect(relativeTime(new Date(now - 3 * 3_600_000), now)).toBe("3 h ago");
    expect(relativeTime(new Date(now - 26 * 3_600_000), now)).toBe("yesterday");
  });
});

describe("tunnel provider", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("stands in with fake tunnels in development, and refuses in production without Cloudflare", async () => {
    for (const name of ["CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_ZONE_ID"]) vi.stubEnv(name, "");
    expect(createTunnelProvider().kind).toBe("fake");
    vi.stubEnv("NODE_ENV", "production");
    const provider = createTunnelProvider();
    expect(provider.kind).toBe("unconfigured");
    await expect(provider.create("0123456789abcdef")).rejects.toThrow("not configured");
  });
});
