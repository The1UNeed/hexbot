import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, parseJson, requireDaemon } from "@/lib/http";
import { getStore } from "@/lib/runtime";
import { daemonIdPattern, PUSH_TARGETS_MAX, PUSHES_PER_MINUTE, pushTokenPattern, sendBotPush } from "@/lib/push";
// Only ids and tokens: the notification's words are Connect's own (lib/push.ts).
const schema = z.object({
  targets: z.array(z.object({ token: z.string().regex(pushTokenPattern), device: z.string().regex(daemonIdPattern) }).strict()).min(1).max(PUSH_TARGETS_MAX),
  section: z.string().regex(daemonIdPattern),
}).strict();
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const daemon = await requireDaemon(request); if (daemon instanceof NextResponse) return daemon;
  const body = await parseJson(request, schema); if (body instanceof NextResponse) return body;
  const { id } = await context.params; if (daemon.id !== id) return jsonError("forbidden", "The daemon token does not match this daemon", 403);
  const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  if (!await getStore().claimRegistrationAttempt(`push:${daemon.id}`, minute, PUSHES_PER_MINUTE)) return jsonError("rate_limited", "Too many pushes; try again in a minute", 429);
  try { return NextResponse.json(await sendBotPush(body)); }
  catch { return jsonError("push_failed", "The push service did not accept the push", 502); }
}
