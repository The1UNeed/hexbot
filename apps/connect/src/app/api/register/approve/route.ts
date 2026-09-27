import { NextResponse } from "next/server";
import { z } from "zod";
import { currentClerkUserId } from "@/lib/auth";
import { jsonError, parseJson } from "@/lib/http";
import { getStore, getTunnels } from "@/lib/runtime";
import { generateSlug, hashToken, randomToken } from "@/lib/tokens";

const schema = z.object({ user_code: z.string().transform(value => value.trim().toUpperCase()).pipe(z.string().regex(/^[A-Z2-9]{4}-?[A-Z2-9]{4}$/)) }).strict();
export async function POST(request: Request) {
  const clerkId = await currentClerkUserId(); if (!clerkId) return jsonError("unauthorized", "Sign in to approve this daemon", 401);
  const body = await parseJson(request, schema); if (body instanceof NextResponse) return body;
  const raw = body.user_code.replace("-", ""); const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  const registration = await getStore().findRegistrationByUserCode(code);
  if (!registration) return jsonError("invalid_user_code", "The user code is invalid", 404);
  if (registration.expiresAt.getTime() <= Date.now()) return jsonError("expired", "The user code has expired", 410);
  if (registration.approvedAt) return jsonError("already_approved", "This registration is already approved", 409);
  const user = await getStore().getOrCreateUser(clerkId); const slug = generateSlug();
  const tunnel = await getTunnels().create(slug);
  try {
    // The daemon's real token is minted when it polls; until then the row holds the hash of a token nobody has.
    const daemon = await getStore().createDaemon({ userId: user.id, name: registration.daemonName, slug, tunnelId: tunnel.tunnelId, tunnelHostname: tunnel.hostname, ingressPort: registration.ingressPort, tokenHash: hashToken(randomToken()) });
    await getStore().approveRegistration(registration.id, user.id, daemon.id);
    return NextResponse.json({ approved: true, daemon_id: daemon.id, name: daemon.name, hostname: daemon.tunnelHostname });
  } catch (error) { await getTunnels().delete(tunnel.tunnelId).catch(() => undefined); throw error; }
}
