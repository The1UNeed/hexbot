import { NextResponse } from "next/server";
import { jsonError, requireClient, requireDaemon } from "@/lib/http";
import { getStore, getTunnels } from "@/lib/runtime";

/** Revoke a daemon. Accepts the owner's client session, or the daemon's own token (used by `hexbot connect disconnect`). */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const daemon = await getStore().getDaemon(id);
  const session = await requireClient(request);
  let allowed = false;
  if (!(session instanceof NextResponse)) allowed = daemon?.userId === session.userId;
  else { const self = await requireDaemon(request); if (self instanceof NextResponse) return session; allowed = self.id === daemon?.id; }
  if (!daemon || daemon.revokedAt || !allowed) return jsonError("not_found", "Daemon not found", 404);
  // Tunnel first, so a failure leaves the daemon listed and revocation can be retried.
  try { await getTunnels().delete(daemon.tunnelId); } catch { return jsonError("tunnel_delete_failed", "The daemon's tunnel could not be deleted; it stays registered", 502); }
  await getStore().revokeDaemon(id, new Date());
  return NextResponse.json({ ok: true });
}
