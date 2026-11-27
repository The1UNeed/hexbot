import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, parseJson, requireDaemon } from "@/lib/http";
import { fakeTunnels, getStore } from "@/lib/runtime";
// The port is bookkeeping for loopback development targets; ingress is set on the daemon, never from here.
const schema = z.object({ port: z.number().int().min(1).max(65535) }).strict();
/**
 * Through Cloudflare a heartbeat records nothing and reads nothing: online state comes from probing the
 * daemon's address, and a database query every five minutes per daemon would keep the database from
 * ever scaling to zero (docs/connect.md, "Online state"). Daemons of every version keep sending it, so it
 * still answers. Only fake tunnels need it, for the loopback port.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!fakeTunnels()) return NextResponse.json({ ok: true });
  const daemon = await requireDaemon(request); if (daemon instanceof NextResponse) return daemon; const body = await parseJson(request, schema); if (body instanceof NextResponse) return body; const { id } = await context.params; if (daemon.id !== id) return jsonError("forbidden", "The daemon token does not match this daemon", 403);
  await getStore().updateDaemonHeartbeat(id, new Date(), body.port); return NextResponse.json({ ok: true, hostname: daemon.tunnelHostname, port: body.port }); }
