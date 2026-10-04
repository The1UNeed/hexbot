import { getStore, getTunnels } from "./runtime";
import type { Daemon } from "./store";

/**
 * Revoke a daemon: tunnel first, so a failure leaves the daemon listed and revocation can be
 * retried. Once the row is revoked no repair can swap its tunnel any more, so a tunnel that a
 * repair slipped in meanwhile is deleted as well; revocation wins every interleaving.
 */
export async function revokeDaemonWithTunnel(daemon: Daemon): Promise<"ok" | "tunnel_delete_failed"> {
  try { await getTunnels().delete(daemon.tunnelId); } catch { return "tunnel_delete_failed"; }
  await getStore().revokeDaemon(daemon.id, new Date());
  const latest = await getStore().getDaemon(daemon.id);
  if (latest && latest.tunnelId !== daemon.tunnelId) await getTunnels().delete(latest.tunnelId).catch(() => undefined);
  return "ok";
}
