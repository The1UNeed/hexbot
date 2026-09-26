import { createHash, randomBytes } from "node:crypto";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT, type JWK } from "jose";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const randomToken = (prefix = "") => `${prefix}${randomBytes(32).toString("base64url")}`;
/** RFC 7636 S256: the daemon sends a hash of its verifier, and proves the verifier at exchange time. */
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier, "ascii").digest("base64url");

/** 64 random bits: a tunnel hostname cannot be guessed or enumerated. */
export const generateSlug = () => randomBytes(8).toString("hex");
/** Grants name this issuer; the daemon pins it at registration. */
export const connectIssuer = () => process.env.CONNECT_BASE_URL ?? "https://connect.hexbot.app";

export interface GrantClaims { sub: string; daemon_id: string; device_name: string }
interface SigningState { privateKey: CryptoKey; publicJwk: JWK; kid: string }
const signing = globalThis as typeof globalThis & { __hexConnectSigning?: Promise<SigningState> };

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
const state = () => signing.__hexConnectSigning ??= loadSigningState();
export const resetSigningKeyForTests = () => { signing.__hexConnectSigning = undefined; };
/** A short-lived login grant for one daemon (`aud`) and its owner (`sub`). `jti` lets the daemon refuse a replayed grant. */
export async function issueGrant(claims: GrantClaims, expiresInSeconds = 300) { const s = await state(); return new SignJWT({ daemon_id: claims.daemon_id, device_name: claims.device_name }).setProtectedHeader({ alg: "ES256", kid: s.kid, typ: "hexbot-grant+jwt" }).setIssuer(connectIssuer()).setAudience(claims.daemon_id).setSubject(claims.sub).setJti(randomBytes(16).toString("base64url")).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds).sign(s.privateKey); }
/** CONNECT_JWKS_EXTRA publishes public keys beside the signing key: the next key before a rotation. Dropping a key revokes it on daemons within ten minutes. */
export async function getJwks() { const s = await state(); return { keys: [s.publicJwk, ...JSON.parse(process.env.CONNECT_JWKS_EXTRA || "[]") as JWK[]] }; }
export async function verifyGrant(token: string, expectedDaemonId?: string, suppliedJwks?: Awaited<ReturnType<typeof getJwks>>): Promise<GrantClaims & { jti: string }> {
  const jwks = suppliedJwks ?? await getJwks();
  const { payload } = await jwtVerify(token, async header => { const jwk = jwks.keys.find(key => key.kid === header.kid); if (!jwk) throw new Error("unknown signing key"); return importJWK(jwk, "ES256"); }, { algorithms: ["ES256"], issuer: connectIssuer(), typ: "hexbot-grant+jwt" });
  if (!payload.sub || !payload.jti || typeof payload.daemon_id !== "string" || typeof payload.device_name !== "string") throw new Error("invalid grant claims");
  if (expectedDaemonId && payload.daemon_id !== expectedDaemonId) throw new Error("grant daemon does not match");
  return { sub: payload.sub, jti: payload.jti, daemon_id: payload.daemon_id, device_name: payload.device_name };
}
