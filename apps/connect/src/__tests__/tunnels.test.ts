import { afterEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair } from "jose";
import { createHmac } from "node:crypto";
import { CloudflareTunnelProvider, FakeTunnelProvider, tunnelName, verifyTunnelProof } from "@/lib/tunnels";
import { resetSigningKeyForTests, tunnelSecret } from "@/lib/tokens";

const provider = () => new CloudflareTunnelProvider("api-token", "account", "zone", "tunnels.test");
const ok = (result: unknown) => Response.json({ success: true, result });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetSigningKeyForTests(); });

describe("tunnel secrets", () => {
  it("uses raw d, HKDF-SHA256 with empty salt and exact info, then HMAC-SHA256 of the name", async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    const jwk = await exportJWK(pair.privateKey);
    vi.stubEnv("CONNECT_SIGNING_KEY_JWK", JSON.stringify(jwk)); resetSigningKeyForTests();
    // Independent RFC 5869 extract + first expand block; SHA-256 output is exactly 32 bytes.
    const prk = createHmac("sha256", Buffer.alloc(32)).update(Buffer.from(jwk.d!, "base64url")).digest();
    const key = createHmac("sha256", prk).update("hexbot tunnel secret v1").update(Buffer.from([1])).digest();
    const name = tunnelName("0123456789abcdef");
    const expected = createHmac("sha256", key).update(name).digest();
    expect(await tunnelSecret(name)).toEqual(expected);
    resetSigningKeyForTests(); expect(await tunnelSecret(name)).toEqual(expected);
    expect(await tunnelSecret(tunnelName("0123456789abcdef"))).not.toEqual(expected);
  });
  it("uses the dev key too, and rejects old proof after signing-key rotation", async () => {
    vi.stubEnv("CONNECT_SIGNING_KEY_JWK", ""); resetSigningKeyForTests();
    const tunnels = new FakeTunnelProvider(); const { tunnelId } = await tunnels.create("0123456789abcdef");
    const token = await tunnels.connectorToken(tunnelId);
    const daemon = { tunnelId, slug: "0123456789abcdef" };
    expect(await verifyTunnelProof(tunnels, token, daemon)).toBe(tunnelId);
    resetSigningKeyForTests();
    expect(await verifyTunnelProof(tunnels, token, daemon)).toBeNull();
  });
});

describe("Cloudflare tunnel API", () => {
  it("creates locally managed tunnels with unique names and a base64 32-byte secret", async () => {
    const bodies: Array<{ name: string; config_src: string; tunnel_secret: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "POST") { bodies.push(JSON.parse(init.body as string)); return ok({ id: "tunnel" }); }
      return ok([]);
    }));
    const tunnels = provider();
    await tunnels.createTunnel(tunnelName("0123456789abcdef"));
    await tunnels.createTunnel(tunnelName("0123456789abcdef"));
    expect(bodies[0].name).not.toBe(bodies[1].name);
    for (const body of bodies) {
      expect(body.name).toMatch(/^hexbot-0123456789abcdef-/);
      expect(body.config_src).toBe("local");
      expect(Buffer.from(body.tunnel_secret, "base64")).toEqual(await tunnelSecret(body.name));
      expect(Buffer.from(body.tunnel_secret, "base64")).toHaveLength(32);
    }
  });
  it.each([null, "2026-10-01T00:00:00Z"])("reads the name of a live or deleted tunnel: %s", async deleted_at => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ name: "hexbot-slug-unique", created_at: "2026-09-01T00:00:00Z", deleted_at })));
    expect(await provider().inspect("tunnel")).toEqual({ name: "hexbot-slug-unique", createdAt: new Date("2026-09-01"), deletedAt: deleted_at ? new Date(deleted_at) : null });
  });
  it.each([404, 200])("cleans hostname DNS even when the tunnel is already gone: %s", async status => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      if (url.includes("/cfd_tunnel/")) return status === 404 ? Response.json({ success: false }, { status }) : ok({ name: "old", created_at: "2026-09-01", deleted_at: "2026-10-01" });
      if (init.method === "GET") return ok([{ id: "record" }]);
      return Response.json({ success: false }, { status: 404 });
    }));
    await provider().delete("tunnel", "slug.tunnels.test");
    expect(calls.some(call => call.includes("name=slug.tunnels.test"))).toBe(true);
    expect(calls.some(call => call.includes("DELETE") && call.includes("/cfd_tunnel/"))).toBe(false);
  });
  it("does not swallow a failure while the tunnel is still live", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("/dns_records")) return init.method === "GET" ? ok([]) : ok({});
      return init.method === "DELETE" ? Response.json({ success: false }, { status: 502 }) : ok({ name: "live", created_at: "2026-09-01", deleted_at: null });
    }));
    await expect(provider().delete("tunnel", "slug.tunnels.test")).rejects.toThrow("Cloudflare request failed (502)");
  });
  it("removes a live tunnel's hostname first, then its connections, then the tunnel", async () => {
    // Cloudflare refuses to delete a tunnel that still has connections.
    const calls: string[] = [];
    let connected = true, deleted = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname.replace(/^.*\/client\/v4/, "");
      calls.push(`${init.method} ${path}`);
      if (path.includes("/dns_records")) return init.method === "GET" ? ok([{ id: "record" }]) : ok({});
      if (path.endsWith("/connections")) { connected = false; return ok(null); }
      if (init.method === "DELETE") { if (connected) return Response.json({ success: false, errors: [{ message: "tunnel has active connections" }] }, { status: 400 }); deleted = true; return ok(null); }
      return ok({ name: "live", created_at: "2026-09-01", deleted_at: deleted ? "2026-10-04" : null });
    }));
    await provider().delete("tunnel", "slug.tunnels.test");
    const deletes = calls.filter(call => call.startsWith("DELETE"));
    expect(deletes).toEqual(["DELETE /zones/zone/dns_records/record", "DELETE /accounts/account/cfd_tunnel/tunnel/connections", "DELETE /accounts/account/cfd_tunnel/tunnel"]);
    expect(deleted).toBe(true);
  });
});
