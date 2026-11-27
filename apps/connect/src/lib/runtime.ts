import { after } from "next/server";
import { createStore, type Daemon, type Store } from "./store";
import { createTunnelProvider, type TunnelProvider } from "./tunnels";
import { probeOrigin, Reachability, type DaemonStatus } from "./reachability";

// Pages and route handlers are separate module graphs in Next, so module-level
// state would give the authorize page and /api/* different in-memory stores.
// Everything process-wide hangs off globalThis instead.
interface Runtime { store: Store; tunnels: TunnelProvider; reachability: Reachability }
const global = globalThis as typeof globalThis & { __hexConnectRuntime?: Runtime };
const runtime = (): Runtime => global.__hexConnectRuntime ??= { store: createStore(), tunnels: createTunnelProvider(), reachability: new Reachability(probeOrigin) };
export const getStore = () => runtime().store;
export const getTunnels = () => runtime().tunnels;
export const getReachability = () => runtime().reachability;
/** True when daemons are reached on loopback instead of a tunnel hostname (development, tests). */
export const fakeTunnels = () => getTunnels().kind === "fake";
/** "Last seen" and "last used" move at most this often, so reads rarely write. */
export const SEEN_REFRESH_MS = 5 * 60_000;
/**
 * Bookkeeping that must never slow or fail a response: it runs after the response
 * is sent, and a failure is only logged. Outside a request (tests) it starts at once.
 */
export function afterResponse(label: string, task: () => Promise<unknown>) {
  const run = () => Promise.resolve().then(task).catch(error => console.error(`Connect: ${label} failed`, error));
  try { after(run); } catch { void run(); }
}
/**
 * Online state for the daemons someone is looking at. One that answers is marked
 * seen after the response, during a request that already woke the database;
 * nothing else writes it, so the database can scale to zero while nobody uses Connect.
 */
export async function daemonStatuses(daemons: Daemon[], now = Date.now()): Promise<Map<string, DaemonStatus>> {
  const statuses = await getReachability().statuses(daemons, fakeTunnels(), now);
  const at = new Date(now); const staleBefore = new Date(now - SEEN_REFRESH_MS);
  for (const d of daemons) {
    if (statuses.get(d.id) !== "online" || (d.lastSeenAt && d.lastSeenAt >= staleBefore)) continue;
    afterResponse("last seen", () => getStore().markDaemonSeen(d.id, at, staleBefore));
  }
  return statuses;
}
/** Tests that care about online state inject a probe; the rest get one that answers "no" and never touches the network. */
export function setRuntimeForTests(next: Omit<Runtime, "reachability"> & { reachability?: Reachability }) { global.__hexConnectRuntime = { reachability: new Reachability(async () => false), ...next }; }
