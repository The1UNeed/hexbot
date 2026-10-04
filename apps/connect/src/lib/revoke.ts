import { getStore, getTunnels } from "./runtime";
import type { Daemon } from "./store";

/** Revocation blocks repairs first. The tunnel ID is a durable cleanup obligation until deletion succeeds. */
export async function revokeDaemonWithTunnel(daemon: Daemon): Promise<"ok" | "tunnel_delete_failed"> {
  const store = getStore();
  await store.revokeDaemon(daemon.id, new Date());
  try {
    for (;;) {
      const row = await store.getDaemon(daemon.id);
      if (!row || !row.tunnelId) return "ok";
      const deleted = row.tunnelId;
      await getTunnels().delete(deleted, row.tunnelHostname);
      if (await store.clearDaemonTunnel(row.id, deleted)) return "ok";
    }
  } catch { return "tunnel_delete_failed"; }
}
