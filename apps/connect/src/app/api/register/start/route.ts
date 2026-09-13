import { randomBytes } from "node:crypto";
import { z } from "zod";
import { getStore } from "@/lib/runtime";
import { hashToken, randomToken } from "@/lib/tokens";
import { jsonError, parseJson } from "@/lib/http";
import { NextResponse } from "next/server";

const schema = z.object({ daemon_name: z.string().trim().min(1).max(100), platform: z.string().trim().min(1).max(50) }).strict();
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const userCode = () => { const bytes = randomBytes(8); const raw = Array.from(bytes, byte => alphabet[byte % alphabet.length]).join(""); return `${raw.slice(0, 4)}-${raw.slice(4)}`; };
export async function POST(request: Request) {
  const body = await parseJson(request, schema); if (body instanceof NextResponse) return body;
  const deviceCode = randomToken("hdc_");
  let code = userCode();
  for (let i = 0; i < 20 && await getStore().findRegistrationByUserCode(code); i++) code = userCode();
  if (await getStore().findRegistrationByUserCode(code)) return jsonError("unavailable", "Could not allocate a registration code", 503);
  await getStore().createRegistration({ userCode: code, deviceCodeHash: hashToken(deviceCode), daemonName: body.daemon_name, platform: body.platform, ingressPort: Number(process.env.CONNECT_INGRESS_PORT ?? 9119), expiresAt: new Date(Date.now() + 10 * 60_000) });
  const origin = process.env.CONNECT_BASE_URL ?? new URL(request.url).origin;
  return NextResponse.json({ device_code: deviceCode, user_code: code, verify_url: `${origin}/connect/approve?code=${encodeURIComponent(code)}`, interval: 5 });
}
