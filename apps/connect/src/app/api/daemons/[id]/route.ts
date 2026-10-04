import { NextResponse } from "next/server";
import { jsonError, requireClient, requireDaemon } from "@/lib/http";
import { revokeDaemonWithTunnel } from "@/lib/revoke";
import { getStore } from "@/lib/runtime";

/** Revoke a daemon. Accepts the owner's client session, or the daemon's own token (used by `hexbot connect disconnect`). */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const daemon = await getStore().getDaemon(id);
  const session = await requireClient(request);
  let allowed = false;
  if (!(session instanceof NextResponse)) allowed = daemon?.userId === session.userId;
  else { const self = await requireDaemon(request, true); if (self instanceof NextResponse) return self.status === 410 ? self : session; allowed = self.id === daemon?.id; }
  if (!daemon || !allowed) return jsonError("not_found", "Daemon not found", 404);
  if (await revokeDaemonWithTunnel(daemon) !== "ok") return jsonError("tunnel_delete_failed", "The daemon is revoked, but its tunnel could not be deleted; retry removal", 502);
  return NextResponse.json({ ok: true });
}
