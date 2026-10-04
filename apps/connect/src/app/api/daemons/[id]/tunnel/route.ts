import { NextResponse } from "next/server";
import { jsonError, requireDaemon } from "@/lib/http";
import { getStore, getTunnels } from "@/lib/runtime";
import { TUNNEL_REPAIR_COOLDOWN_MS } from "@/lib/tunnels";

/**
 * A daemon whose cloudflared cannot get an edge connection asks for a tunnel that works.
 * If its tunnel still exists, the hostname is pointed at it again and nothing else
 * changes: the daemon keeps the token it has, and this route never hands out
 * credentials for a tunnel that is live (a stolen daemon token must not get a second
 * connector onto the trusted hostname). Only when the tunnel is gone is a replacement
 * created under the same hostname and its token returned. The request body is ignored:
 * ingress is set on the daemon, never from here (docs/connect.md, "Tunnel repair").
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const daemon = await requireDaemon(request); if (daemon instanceof NextResponse) return daemon;
  const { id } = await context.params; if (daemon.id !== id) return jsonError("forbidden", "The daemon token does not match this daemon", 403);
  const tunnels = getTunnels(); const store = getStore();
  const revoked = () => jsonError("daemon_revoked", "This daemon was revoked in Hex Connect", 410);
  // One repair per two minutes per daemon, claimed before any Cloudflare call, so a looping
  // daemon (or a looping holder of its token) cannot spend the account's API quota.
  if (!await store.claimTunnelRepair(daemon.id, new Date(), TUNNEL_REPAIR_COOLDOWN_MS)) return jsonError("tunnel_recent", "A repair ran moments ago; try again in two minutes", 429);
  // Always act on a fresh read: the row may move on underneath this request.
  const row = await store.getDaemon(daemon.id);
  if (!row || row.revokedAt) return revoked();
  // The tunnel from that fresh read; the in-memory store hands out the live row, which the swap below mutates.
  const previous = row.tunnelId;
  const current = await tunnels.inspect(previous);
  if (current && !current.deletedAt) {
    // Re-pointing is idempotent and heals a replacement whose DNS update failed half-way.
    await tunnels.pointHostname(row.tunnelHostname, previous);
    const after = await store.getDaemon(row.id);
    if (!after || after.revokedAt) { await tunnels.delete(previous).catch(() => undefined); return revoked(); }
    return NextResponse.json({ tunnel_hostname: row.tunnelHostname, replaced: false });
  }
  const fresh = await tunnels.createTunnel(`hexbot-${row.slug}-${Date.now().toString(36)}`);
  if (!await store.swapDaemonTunnel(row.id, previous, fresh.tunnelId)) {
    // Revoked meanwhile, or another request replaced the tunnel first: drop ours (never its DNS).
    await tunnels.deleteTunnel(fresh.tunnelId).catch(() => undefined);
    const latest = await store.getDaemon(row.id);
    if (!latest || latest.revokedAt) return revoked();
    await tunnels.pointHostname(latest.tunnelHostname, latest.tunnelId);
    const after = await store.getDaemon(row.id);
    if (!after || after.revokedAt) { await tunnels.delete(latest.tunnelId).catch(() => undefined); return revoked(); }
    return NextResponse.json({ tunnel_token: await tunnels.connectorToken(latest.tunnelId), tunnel_hostname: latest.tunnelHostname, replaced: true });
  }
  await tunnels.pointHostname(row.tunnelHostname, fresh.tunnelId);
  await tunnels.deleteTunnel(previous).catch(() => undefined);
  // A revoke that landed between the swap and here has already deleted what it saw; nothing of ours may outlive it.
  const after = await store.getDaemon(row.id);
  if (!after || after.revokedAt) { await tunnels.delete(fresh.tunnelId).catch(() => undefined); return revoked(); }
  return NextResponse.json({ tunnel_token: await tunnels.connectorToken(fresh.tunnelId), tunnel_hostname: row.tunnelHostname, replaced: true });
}
