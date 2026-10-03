import { NextResponse } from "next/server";
import { jsonError, requireDaemon } from "@/lib/http";
import { getStore, getTunnels } from "@/lib/runtime";
import { TUNNEL_REPAIR_COOLDOWN_MS } from "@/lib/tunnels";

/**
 * A daemon whose cloudflared keeps failing asks for a tunnel that works. If its tunnel still
 * exists it gets a fresh connector token; if the tunnel is gone it gets a replacement under
 * the same hostname, so saved targets keep working. The request body is ignored: ingress is
 * set on the daemon, never from here (docs/connect.md, "Tunnel repair").
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const daemon = await requireDaemon(request); if (daemon instanceof NextResponse) return daemon;
  const { id } = await context.params; if (daemon.id !== id) return jsonError("forbidden", "The daemon token does not match this daemon", 403);
  const tunnels = getTunnels(); const store = getStore();
  // The tunnel this request set out to repair; the row may move on underneath it.
  const previous = daemon.tunnelId;
  const current = await tunnels.inspect(previous);
  if (current && Date.now() - current.createdAt.getTime() < TUNNEL_REPAIR_COOLDOWN_MS) return jsonError("tunnel_recent", "The tunnel was created moments ago; try again in two minutes", 429);
  if (current && !current.deletedAt) {
    // Re-pointing is idempotent and heals a replacement whose DNS update failed half-way.
    await tunnels.pointHostname(daemon.tunnelHostname, previous);
    return NextResponse.json({ tunnel_token: await tunnels.connectorToken(previous), tunnel_hostname: daemon.tunnelHostname, replaced: false });
  }
  const fresh = await tunnels.createTunnel(`hexbot-${daemon.slug}-${Date.now().toString(36)}`);
  if (!await store.swapDaemonTunnel(daemon.id, previous, fresh.tunnelId)) {
    // Another request replaced the tunnel first: drop ours (never its DNS) and hand out theirs.
    await tunnels.deleteTunnel(fresh.tunnelId).catch(() => undefined);
    const latest = await store.getDaemon(daemon.id);
    if (!latest || latest.revokedAt) return jsonError("daemon_revoked", "This daemon was revoked in Hex Connect", 410);
    return NextResponse.json({ tunnel_token: await tunnels.connectorToken(latest.tunnelId), tunnel_hostname: latest.tunnelHostname, replaced: true });
  }
  await tunnels.pointHostname(daemon.tunnelHostname, fresh.tunnelId);
  await tunnels.deleteTunnel(previous).catch(() => undefined);
  return NextResponse.json({ tunnel_token: await tunnels.connectorToken(fresh.tunnelId), tunnel_hostname: daemon.tunnelHostname, replaced: true });
}
