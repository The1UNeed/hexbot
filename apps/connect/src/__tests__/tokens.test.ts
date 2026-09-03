import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "@/lib/store";
import { generateSlug, getJwks, hashToken, issueGrant, resetSigningKeyForTests, verifyGrant } from "@/lib/tokens";

beforeEach(() => { delete process.env.CONNECT_SIGNING_KEY_JWK; resetSigningKeyForTests(); });
describe("tokens", () => {
  it("hashes tokens deterministically without retaining plaintext", () => { expect(hashToken("secret")).toBe("2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b"); expect(hashToken("secret")).not.toContain("secret"); });
  it("issues and verifies grants", async () => { const token = await issueGrant({ sub: "user", daemon_id: "daemon", device_name: "Laptop" }); await expect(verifyGrant(token, "daemon")).resolves.toEqual({ sub: "user", daemon_id: "daemon", device_name: "Laptop" }); });
  it("rejects expired grants", async () => { const token = await issueGrant({ sub: "user", daemon_id: "daemon", device_name: "Laptop" }, -1); await expect(verifyGrant(token)).rejects.toThrow(); });
  it("rejects a grant for another daemon", async () => { const token = await issueGrant({ sub: "user", daemon_id: "one", device_name: "Laptop" }); await expect(verifyGrant(token, "two")).rejects.toThrow("does not match"); });
  it("rejects an unknown key id", async () => { const token = await issueGrant({ sub: "user", daemon_id: "one", device_name: "Laptop" }); const jwks = await getJwks(); jwks.keys[0].kid = "unknown"; await expect(verifyGrant(token, undefined, jwks)).rejects.toThrow("unknown signing key"); });
});
describe("slugs", () => { it("produces unique slugs against the store", async () => { const store = new MemoryStore(); const seen = new Set<string>(); store.slugExists = async value => seen.has(value); for (let i = 0; i < 40; i++) { const slug = await generateSlug(store); expect(seen.has(slug)).toBe(false); seen.add(slug); } }); });
