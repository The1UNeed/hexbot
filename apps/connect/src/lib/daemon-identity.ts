import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";

/** Raw Ed25519 public key, canonical unpadded base64url. */
export const identityKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine(
  key => Buffer.from(key, "base64url").toString("base64url") === key,
  "Invalid daemon identity key",
);

export function identityHost(origin: string): string {
  const url = new URL(origin);
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  return url.port && url.port !== "80" && url.port !== "443" ? `${host}:${url.port}` : host;
}

export function verifyIdentity(body: unknown, daemonId: string, publicKey: string, host: string, nonce: string): boolean {
  if (!body || typeof body !== "object") return false;
  const reply = body as Record<string, unknown>;
  if (reply.daemon_id !== daemonId || reply.public_key !== publicKey || typeof reply.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(reply.signature)) return false;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
    return verify(null, Buffer.from(`hexbot-identity-v1\n${daemonId}\n${host}\n${nonce}`), key, Buffer.from(reply.signature, "base64url"));
  } catch { return false; }
}
