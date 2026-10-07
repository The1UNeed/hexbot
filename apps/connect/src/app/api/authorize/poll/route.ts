import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJson } from "@/lib/http";
import { getStore } from "@/lib/runtime";
import { hashToken, pkceChallenge, randomToken } from "@/lib/tokens";

const schema = z.object({ verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/) }).strict();
/** The app polls with its PKCE verifier until the user approves it; the session token exists only in the one response that collects it. */
export async function POST(request: Request) {
  const body = await parseJson(request, schema); if (body instanceof NextResponse) return body;
  const approved = await getStore().claimClientAuthorization(pkceChallenge(body.verifier), new Date());
  if (!approved) return NextResponse.json({ status: "pending", interval: 2 });
  const token = randomToken("hxc_");
  await getStore().createClientSession({ userId: approved.userId, tokenHash: hashToken(token), deviceName: approved.deviceName });
  return NextResponse.json({ status: "approved", session: token });
}
