import { NextResponse } from "next/server";
import { requireClient, jsonError } from "@/lib/http";
import { getStore } from "@/lib/runtime";
import { issueGrant } from "@/lib/tokens";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { const session = await requireClient(request); if (session instanceof NextResponse) return session; const { id } = await context.params; const daemon = await getStore().getDaemon(id); if (!daemon || daemon.revokedAt || daemon.userId !== session.userId) return jsonError("not_found", "Daemon not found", 404); const grant = await issueGrant({ sub: session.userId, daemon_id: daemon.id, device_name: session.deviceName }); return NextResponse.json({ grant, expires_in: 300, daemon: { id: daemon.id, name: daemon.name, host: daemon.tunnelHostname, port: 443, tls: true } }); }
