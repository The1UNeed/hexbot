import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, parseJson, requireDaemon } from "@/lib/http";
import { getStore } from "@/lib/runtime";
import { PUSH_TOKENS_MAX, PUSHES_PER_MINUTE, pushTokenPattern, sendCheckinPush } from "@/lib/push";
// The bot's name is the only text a daemon chooses; it is bounded and has no control characters.
const schema = z.object({
  tokens: z.array(z.string().regex(pushTokenPattern)).min(1).max(PUSH_TOKENS_MAX),
  bot: z.string().min(1).max(64).regex(/^[^\p{Cc}]+$/u),
  section: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
}).strict();
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const daemon = await requireDaemon(request); if (daemon instanceof NextResponse) return daemon;
  const body = await parseJson(request, schema); if (body instanceof NextResponse) return body;
  const { id } = await context.params; if (daemon.id !== id) return jsonError("forbidden", "The daemon token does not match this daemon", 403);
  const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  if (!await getStore().claimRegistrationAttempt(`push:${daemon.id}`, minute, PUSHES_PER_MINUTE)) return jsonError("rate_limited", "Too many pushes; try again in a minute", 429);
  try { return NextResponse.json({ gone: await sendCheckinPush(body) }); }
  catch { return jsonError("push_failed", "The push service did not accept the push", 502); }
}
