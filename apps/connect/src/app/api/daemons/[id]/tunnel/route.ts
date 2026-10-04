import { NextResponse } from "next/server";
import { jsonError, requireDaemon } from "@/lib/http";
import { getStore, getTunnels } from "@/lib/runtime";
import { TUNNEL_REPAIR_COOLDOWN_MS, tunnelName, verifyTunnelProof } from "@/lib/tunnels";

/** Repair requires both the daemon token and proof of a connector secret. Ingress stays local. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const daemon = await requireDaemon(request); if (daemon instanceof NextResponse) return daemon;
  const { id } = await context.params; if (daemon.id !== id) return jsonError("forbidden", "The daemon token does not match this daemon", 403);
  const tunnels = getTunnels(); const store = getStore();
  const revoked = () => jsonError("daemon_revoked", "This daemon was revoked in Hex Connect", 410);
  const failed = () => jsonError("tunnel_repair_failed", "The tunnel could not be repaired; try again later", 502);
  // Claim before Cloudflare reads too, so a looping caller cannot exhaust its API quota.
  if (!await store.claimTunnelRepair(id, new Date(), TUNNEL_REPAIR_COOLDOWN_MS)) return jsonError("tunnel_recent", "A repair ran moments ago; try again in two minutes", 429);
  const row = await store.getDaemon(id);
  if (!row || row.revokedAt) return revoked();
  const previous = row.tunnelId;
  const hostname = row.tunnelHostname;
  let created: string | undefined;
  try {
    const body = await request.json().catch(() => null);
    const proof = await verifyTunnelProof(tunnels, body?.tunnel_token, row);
    if (!proof) return jsonError("forbidden", "Tunnel credentials are required; run hexbot connect again if they predate tunnel repair", 403);
    const checked = await store.getDaemon(id);
    if (!checked || checked.revokedAt) return revoked();
    let target = previous;
    const current = await tunnels.inspect(target);
    if (!current || current.deletedAt) {
      created = (await tunnels.createTunnel(tunnelName(row.slug))).tunnelId;
      if (await store.swapDaemonTunnel(id, previous, created)) target = created;
      else {
        await tunnels.deleteTunnel(created);
        created = undefined;
        const latest = await store.getDaemon(id);
        if (!latest || latest.revokedAt) return revoked();
        target = latest.tunnelId;
      }
    }
    // Get credentials before the final revocation check. A stale proof recovers a lost response.
    const replaced = target !== proof;
    const token = replaced ? await tunnels.connectorToken(target) : undefined;
    await tunnels.pointHostname(hostname, target);
    if (target !== previous) await tunnels.deleteTunnel(previous).catch(() => undefined);
    const after = await store.getDaemon(id);
    if (!after || after.revokedAt) {
      // The daemon must learn it was revoked even if this cleanup fails; revoke's own retry covers the rest.
      await tunnels.delete(target, hostname).catch(() => undefined);
      return revoked();
    }
    if (after.tunnelId !== target) {
      // A later repair won during our DNS write. Remove only records pointing at our tunnel.
      if (created) await tunnels.delete(created);
      return failed();
    }
    return NextResponse.json({ tunnel_hostname: hostname, replaced, ...(token ? { tunnel_token: token } : {}) });
  } catch {
    // Keep the row's tunnel ID for retries. Never remove another repair's DNS or tunnel.
    if (created) await tunnels.delete(created).catch(() => undefined);
    return failed();
  }
}
