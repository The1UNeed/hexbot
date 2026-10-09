import { NextResponse } from "next/server";
import { z } from "zod";
import { currentClerkUserId } from "@/lib/auth";
import { jsonError, parseJson } from "@/lib/http";
import { revokeDaemonWithTunnel } from "@/lib/revoke";
import { getStore, getTunnels } from "@/lib/runtime";
import type { Daemon } from "@/lib/store";
import { generateSlug, hashToken, randomToken } from "@/lib/tokens";

/** Vercel stops an approval after this long; the registration claim's lease (REGISTRATION_CLAIM_LEASE_MS) outlives it. */
export const maxDuration = 60;
const schema = z.object({ user_code: z.string().transform(value => value.trim().toUpperCase()).pipe(z.string().regex(/^[A-Z2-9]{4}-?[A-Z2-9]{4}$/)) }).strict();
export async function POST(request: Request) {
  const clerkId = await currentClerkUserId(); if (!clerkId) return jsonError("unauthorized", "Sign in to approve this daemon", 401);
  const body = await parseJson(request, schema); if (body instanceof NextResponse) return body;
  const raw = body.user_code.replace("-", ""); const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  const registration = await getStore().findRegistrationByUserCode(code);
  if (!registration) return jsonError("invalid_user_code", "The user code is invalid", 404);
  if (registration.expiresAt.getTime() <= Date.now()) return jsonError("expired", "The user code has expired", 410);
  if (registration.daemonId) return jsonError("already_approved", "This registration is already approved", 409);
  const user = await getStore().getOrCreateUser(clerkId);
  // Claim before creating anything: of two overlapping approvals only one gets a tunnel and a daemon. A claim left behind by an approval that died keeps the code only for its lease.
  const claim = { userId: user.id, at: new Date() };
  if (!await getStore().claimRegistration(registration.id, claim)) return jsonError("already_approved", "This registration is already approved", 409);
  const slug = generateSlug();
  let tunnel: { tunnelId: string; hostname: string };
  try { tunnel = await getTunnels().create(slug); }
  catch (error) { await getStore().releaseRegistration(registration.id, claim).catch(() => undefined); throw error; }
  let daemon: Daemon | undefined;
  try {
    // The daemon's real token is minted when it polls; until then the row holds the hash of a token nobody has.
    daemon = await getStore().createDaemon({ userId: user.id, name: registration.daemonName, slug, tunnelId: tunnel.tunnelId, tunnelHostname: tunnel.hostname, ingressPort: registration.ingressPort, tokenHash: hashToken(randomToken()) });
    await getStore().approveRegistration(registration.id, claim, daemon.id);
    return NextResponse.json({ approved: true, daemon_id: daemon.id, name: daemon.name, hostname: daemon.tunnelHostname });
  } catch (error) {
    // A daemon row that exists must be revoked, not just lose its tunnel, or it would sit in the list as a dead daemon.
    if (daemon) await revokeDaemonWithTunnel(daemon).catch(() => undefined);
    else await getTunnels().delete(tunnel.tunnelId).catch(() => undefined);
    await getStore().releaseRegistration(registration.id, claim).catch(() => undefined);
    throw error;
  }
}
