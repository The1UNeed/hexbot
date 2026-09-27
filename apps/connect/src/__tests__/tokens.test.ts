import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSlug, getJwks, hashToken, issueGrant, resetSigningKeyForTests, verifyGrant } from "@/lib/tokens";

beforeEach(() => { delete process.env.CONNECT_SIGNING_KEY_JWK; resetSigningKeyForTests(); });
describe("tokens", () => {
  it("hashes tokens deterministically without retaining plaintext", () => { expect(hashToken("secret")).toBe("2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b"); expect(hashToken("secret")).not.toContain("secret"); });
  it("issues and verifies grants", async () => { const token = await issueGrant({ sub: "user", daemon_id: "daemon", device_name: "Laptop" }); const claims = await verifyGrant(token, "daemon"); expect(claims).toMatchObject({ sub: "user", daemon_id: "daemon", device_name: "Laptop" }); expect(claims.jti).toMatch(/^[A-Za-z0-9_-]{22}$/); });
  it("names its type, issuer, daemon audience, and owner", async () => { const [header, payload] = (await issueGrant({ sub: "owner", daemon_id: "daemon", device_name: "Laptop" })).split(".").slice(0, 2).map(part => JSON.parse(Buffer.from(part, "base64url").toString())); expect(header).toMatchObject({ alg: "ES256", typ: "hexbot-grant+jwt" }); expect(payload).toMatchObject({ iss: "https://connect.hexbot.app", aud: "daemon", sub: "owner", daemon_id: "daemon" }); });
  it("publishes extra keys beside the signing key for rotation", async () => { vi.stubEnv("CONNECT_JWKS_EXTRA", JSON.stringify([{ kid: "next", kty: "EC", crv: "P-256", x: "x", y: "y" }])); expect((await getJwks()).keys.map(key => key.kid)).toEqual([expect.any(String), "next"]); vi.unstubAllEnvs(); });
  it("rejects expired grants", async () => { const token = await issueGrant({ sub: "user", daemon_id: "daemon", device_name: "Laptop" }, -1); await expect(verifyGrant(token)).rejects.toThrow(); });
  it("rejects a grant for another daemon", async () => { const token = await issueGrant({ sub: "user", daemon_id: "one", device_name: "Laptop" }); await expect(verifyGrant(token, "two")).rejects.toThrow("does not match"); });
  it("rejects an unknown key id", async () => { const token = await issueGrant({ sub: "user", daemon_id: "one", device_name: "Laptop" }); const jwks = await getJwks(); jwks.keys[0].kid = "unknown"; await expect(verifyGrant(token, undefined, jwks)).rejects.toThrow("unknown signing key"); });
});
describe("slugs", () => { it("are 64 random bits, so hostnames cannot be enumerated", () => { expect(generateSlug()).toMatch(/^[0-9a-f]{16}$/); expect(generateSlug()).not.toBe(generateSlug()); }); });
