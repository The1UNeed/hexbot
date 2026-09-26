// node --test tests/hexbot/*.test.mts
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const home = process.env.HEXBOT_HOME = mkdtempSync(join(tmpdir(), "hexbot-agent-"));
const { cloudflared, verifyGrant } = await import("../../hexbot/connect_agent.mts");

const keyPair = (kid: string) => { const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" }); return { privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid } }; };
const pinned = keyPair("pinned"), other = keyPair("other"), retired = keyPair("retired");
const base64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const good = { iss: "https://connect.test", aud: "daemon-1", sub: "owner-1", daemon_id: "daemon-1", device_name: "MacBook", jti: "j1", iat: now, exp: now + 300 };

function grant(claims: object = good, { key = pinned.privateKey as KeyObject, kid = "pinned", typ = "hexbot-grant+jwt" } = {}) {
  const body = `${base64({ alg: "ES256", kid, typ })}.${base64(claims)}`;
  return `${body}.${sign("sha256", Buffer.from(body), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

// Pinned at registration: `pinned` and `retired`. Published now (fresh cache, so no network): `pinned` and `other`.
writeFileSync(join(home, "connect.json"), JSON.stringify({ api_base: "https://connect.test", daemon_id: "daemon-1", owner_id: "owner-1", issuer: "https://connect.test", keys: [pinned.jwk, retired.jwk], tunnel_token: "t" }));
writeFileSync(join(home, "connect-jwks.json"), JSON.stringify({ at: Date.now() / 1000, keys: [pinned.jwk, other.jwk] }));

test("accepts a grant from a pinned, published key for the pinned owner", async () => {
  assert.equal((await verifyGrant(grant())).device_name, "MacBook");
});

test("rejects grants that break any pinned binding", async () => {
  const cases: Array<[string, RegExp]> = [
    [grant({ ...good, sub: "intruder" }), /sub does not match/],
    [grant({ ...good, aud: "daemon-2" }), /aud does not match/],
    [grant({ ...good, iss: "https://evil.test" }), /iss does not match/],
    [grant(good, { typ: "JWT" }), /unsupported grant header/],
    [grant(good, { key: other.privateKey, kid: "other" }), /not pinned or no longer published/], // published, never pinned
    [grant(good, { key: retired.privateKey, kid: "retired" }), /not pinned or no longer published/], // pinned, withdrawn
    [grant(good, { key: other.privateKey }), /bad grant signature/],
    [grant({ ...good, exp: now - 120 }), /expired or incomplete/],
    [grant({ ...good, exp: String(now + 300) }), /expired or incomplete/],
    [grant({ ...good, jti: undefined }), /expired or incomplete/],
    [`${grant()}.extra`, /malformed grant/],
  ];
  for (const [token, reason] of cases) await assert.rejects(verifyGrant(token), reason);
});

test("refetches a damaged or future-dated key cache instead of trusting it", async () => {
  const cache = join(home, "connect-jwks.json"), fresh = readFileSync(cache, "utf8");
  for (const damaged of ["{", JSON.stringify({ at: Date.now() / 1000 + 3600, keys: [pinned.jwk] })]) {
    writeFileSync(cache, damaged);
    await assert.rejects(verifyGrant(grant())); // the refetch goes to https://connect.test, which does not resolve
  }
  writeFileSync(cache, fresh);
});

test("refuses a cloudflared download whose digest does not match the pin", async () => {
  const fetcher = (async () => new Response("tampered")) as unknown as typeof fetch;
  await assert.rejects(cloudflared(fetcher), /pinned SHA-256|unsupported/);
  assert.equal(existsSync(join(home, "bin")), false);
});
