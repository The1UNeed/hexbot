import { NextResponse } from "next/server";
import { requireClient, jsonError } from "@/lib/http";
import { daemonTarget } from "@/lib/daemons";
import { fakeTunnels, getStore } from "@/lib/runtime";
import { issueGrant } from "@/lib/tokens";

/** A login grant for the app: it redeems the grant at the daemon's password-login route for a device token. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireClient(request); if (session instanceof NextResponse) return session;
  const { id } = await context.params;
  const daemon = await getStore().getDaemon(id);
  if (!daemon || daemon.revokedAt || daemon.userId !== session.userId) return jsonError("not_found", "Daemon not found", 404);
  const grant = await issueGrant({ sub: session.userId, daemon_id: daemon.id, device_name: session.deviceName });
  const target = daemonTarget(daemon, fakeTunnels());
  return NextResponse.json({ grant, expires_in: 300, daemon: { id: daemon.id, name: daemon.name, ...target } });
}
