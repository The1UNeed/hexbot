import { createHash, randomBytes } from "node:crypto";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT, type JWK } from "jose";
import type { Store } from "./store";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const randomToken = (prefix = "") => `${prefix}${randomBytes(32).toString("base64url")}`;

const adjectives = ["amber", "brisk", "calm", "coral", "gentle", "lucky", "misty", "quiet", "solar", "swift"];
const nouns = ["badger", "cedar", "comet", "falcon", "harbor", "otter", "panda", "river", "spruce", "willow"];
export async function generateSlug(store: Store): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const slug = `${adjectives[randomBytes(1)[0] % adjectives.length]}-${nouns[randomBytes(1)[0] % nouns.length]}-${randomBytes(2).readUInt16BE() % 10000}`;
    if (!await store.slugExists(slug)) return slug;
  }
  throw new Error("could not generate a unique daemon slug");
}

export interface GrantClaims { sub: string; daemon_id: string; device_name: string }
interface SigningState { privateKey: CryptoKey; publicJwk: JWK; kid: string }
let signingState: Promise<SigningState> | undefined;

async function loadSigningState(): Promise<SigningState> {
  const configured = process.env.CONNECT_SIGNING_KEY_JWK;
  if (configured) {
    const jwk = JSON.parse(configured) as JWK;
    const privateKey = await importJWK(jwk, "ES256") as CryptoKey;
    const publicJwk = { ...jwk }; delete publicJwk.d;
    const kid = jwk.kid ?? await calculateJwkThumbprint(publicJwk);
    return { privateKey, publicJwk: { ...publicJwk, kid, use: "sig", alg: "ES256" }, kid };
  }
  console.warn("CONNECT_SIGNING_KEY_JWK is unset; using an in-memory development signing key.");
  const pair = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  return { privateKey: pair.privateKey, publicJwk: { ...publicJwk, kid, use: "sig", alg: "ES256" }, kid };
}
const state = () => signingState ??= loadSigningState();
export const resetSigningKeyForTests = () => { signingState = undefined; };
export async function issueGrant(claims: GrantClaims, expiresInSeconds = 300) { const s = await state(); return new SignJWT({ daemon_id: claims.daemon_id, device_name: claims.device_name }).setProtectedHeader({ alg: "ES256", kid: s.kid }).setSubject(claims.sub).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds).sign(s.privateKey); }
export async function getJwks() { const s = await state(); return { keys: [s.publicJwk] }; }
export async function verifyGrant(token: string, expectedDaemonId?: string, suppliedJwks?: Awaited<ReturnType<typeof getJwks>>): Promise<GrantClaims> {
  const jwks = suppliedJwks ?? await getJwks();
  const { payload } = await jwtVerify(token, async header => { const jwk = jwks.keys.find(key => key.kid === header.kid); if (!jwk) throw new Error("unknown signing key"); return importJWK(jwk, "ES256"); }, { algorithms: ["ES256"] });
  if (!payload.sub || typeof payload.daemon_id !== "string" || typeof payload.device_name !== "string") throw new Error("invalid grant claims");
  if (expectedDaemonId && payload.daemon_id !== expectedDaemonId) throw new Error("grant daemon does not match");
  return { sub: payload.sub, daemon_id: payload.daemon_id, device_name: payload.device_name };
}
