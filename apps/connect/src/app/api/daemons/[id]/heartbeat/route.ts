import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, parseJson, requireDaemon } from "@/lib/http";
import { getStore, getTunnels } from "@/lib/runtime";
const schema = z.object({ port: z.number().int().min(1).max(65535) }).strict();
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { const daemon = await requireDaemon(request); if (daemon instanceof NextResponse) return daemon; const body = await parseJson(request, schema); if (body instanceof NextResponse) return body; const { id } = await context.params; if (daemon.id !== id) return jsonError("forbidden", "The daemon token does not match this daemon", 403); if (daemon.ingressPort !== body.port) { try { await getTunnels().setIngress(daemon.tunnelId, daemon.tunnelHostname, body.port); } catch { return jsonError("tunnel_update_failed", "The tunnel could not be pointed at the reported port", 502); } }
  await getStore().updateDaemonHeartbeat(id, new Date(), body.port); return NextResponse.json({ ok: true, hostname: daemon.tunnelHostname, port: body.port }); }
