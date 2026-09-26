import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, parseJson } from "@/lib/http";
import { getStore, getTunnels } from "@/lib/runtime";
import { connectIssuer, getJwks, hashToken, randomToken } from "@/lib/tokens";

const schema = z.object({ device_code: z.string().min(1) }).strict();
export async function POST(request: Request) {
  const body = await parseJson(request, schema); if (body instanceof NextResponse) return body;
  const row = await getStore().findRegistrationByDeviceHash(hashToken(body.device_code));
  if (!row) return jsonError("invalid_device_code", "The device code is invalid", 404);
  if (row.expiresAt.getTime() <= Date.now()) return NextResponse.json({ status: "expired" });
  if (row.consumedAt) return jsonError("consumed", "The registration credentials have already been collected", 410);
  if (!row.approvedAt || !row.daemonId) return NextResponse.json({ status: "pending", interval: 5 });
  const daemon = await getStore().getDaemon(row.daemonId);
  if (!daemon || daemon.revokedAt) return NextResponse.json({ status: "denied" });
  // Secrets exist only in this response: the tunnel token comes from Cloudflare, the daemon token is minted here and stored hashed.
  const tunnelToken = await getTunnels().connectorToken(daemon.tunnelId);
  if (!await getStore().consumeRegistration(row.id)) return jsonError("consumed", "The registration credentials have already been collected", 410);
  const daemonToken = randomToken("hxd_"); await getStore().setDaemonTokenHash(daemon.id, hashToken(daemonToken));
  // The daemon pins owner_id, issuer, and keys: it accepts grants only for this owner, from this issuer, signed by these keys.
  return NextResponse.json({ status: "approved", daemon_token: daemonToken, daemon_id: daemon.id, slug: daemon.slug, tunnel_token: tunnelToken, tunnel_hostname: daemon.tunnelHostname, owner_id: daemon.userId, issuer: connectIssuer(), keys: (await getJwks()).keys });
}
