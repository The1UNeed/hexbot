import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, parseJson, requireDaemon } from "@/lib/http";
import { getStore } from "@/lib/runtime";
import { hashToken, issueGrant, pkceChallenge } from "@/lib/tokens";

const schema = z.object({ code: z.string().min(1).max(200), code_verifier: z.string().min(43).max(128), redirect_uri: z.string().min(1).max(2000) }).strict();

/** The daemon trades the one-time code its browser callback received for a login grant (docs/connect.md, browser sign-in). */
export async function POST(request: Request) {
  const daemon = await requireDaemon(request); if (daemon instanceof NextResponse) return daemon;
  const body = await parseJson(request, schema); if (body instanceof NextResponse) return body;
  const row = await getStore().findGrantCodeByHash(hashToken(body.code));
  if (!row || row.daemonId !== daemon.id) return jsonError("invalid_code", "The sign-in code is invalid", 404);
  if (row.expiresAt.getTime() <= Date.now()) return jsonError("expired", "The sign-in code has expired", 410);
  if (row.consumedAt) return jsonError("consumed", "The sign-in code has already been used", 409);
  const challenge = Buffer.from(pkceChallenge(body.code_verifier));
  const expected = Buffer.from(row.challenge);
  if (challenge.length !== expected.length || !timingSafeEqual(challenge, expected) || body.redirect_uri !== row.redirectUri) return jsonError("invalid_request", "The sign-in code does not match this request", 400);
  if (!await getStore().consumeGrantCode(row.id)) return jsonError("consumed", "The sign-in code has already been used", 409);
  const grant = await issueGrant({ sub: row.userId, daemon_id: daemon.id, device_name: row.deviceName });
  return NextResponse.json({ grant, device_name: row.deviceName, expires_in: 300 });
}
