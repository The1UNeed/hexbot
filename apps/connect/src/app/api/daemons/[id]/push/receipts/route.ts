import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, parseJson, requireDaemon } from "@/lib/http";
import { getStore } from "@/lib/runtime";
import { checkinPushReceipts, PUSHES_PER_MINUTE, RECEIPTS_MAX } from "@/lib/push";
// Expo's receipt ids are UUIDs.
const schema = z.object({ ids: z.array(z.string().regex(/^[A-Za-z0-9-]{1,64}$/)).min(1).max(RECEIPTS_MAX) }).strict();
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const daemon = await requireDaemon(request); if (daemon instanceof NextResponse) return daemon;
  const body = await parseJson(request, schema); if (body instanceof NextResponse) return body;
  const { id } = await context.params; if (daemon.id !== id) return jsonError("forbidden", "The daemon token does not match this daemon", 403);
  const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  if (!await getStore().claimRegistrationAttempt(`receipts:${daemon.id}`, minute, PUSHES_PER_MINUTE)) return jsonError("rate_limited", "Too many receipt checks; try again in a minute", 429);
  try { return NextResponse.json({ gone: await checkinPushReceipts(body.ids) }); }
  catch { return jsonError("push_failed", "The push service did not answer", 502); }
}
