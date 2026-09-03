import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, parseJson } from "@/lib/http";
import { getStore } from "@/lib/runtime";
import { hashToken } from "@/lib/tokens";

const schema = z.object({ device_code: z.string().min(1) }).strict();
export async function POST(request: Request) {
  const body = await parseJson(request, schema); if (body instanceof NextResponse) return body;
  const row = await getStore().findRegistrationByDeviceHash(hashToken(body.device_code));
  if (!row) return jsonError("invalid_device_code", "The device code is invalid", 404);
  if (row.expiresAt.getTime() <= Date.now()) return NextResponse.json({ status: "expired" });
  if (row.consumedAt) return jsonError("consumed", "The registration credentials have already been collected", 410);
  if (!row.approvedAt || !row.credentials) return NextResponse.json({ status: "pending", interval: 5 });
  const c = row.credentials;
  if (!await getStore().consumeRegistration(row.id)) return jsonError("consumed", "The registration credentials have already been collected", 410);
  return NextResponse.json({ status: "approved", daemon_token: c.daemonToken, daemon_id: c.daemonId, slug: c.slug, tunnel_token: c.tunnelToken, tunnel_hostname: c.tunnelHostname });
}
