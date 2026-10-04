import { createStore, type Store } from "./store";
import { createTunnelProvider, type TunnelProvider } from "./tunnels";
import { probeOrigin, Reachability } from "./reachability";

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
/** Tests that care about online state inject a probe; the rest get one that answers "no" and never touches the network. */
export function setRuntimeForTests(next: Omit<Runtime, "reachability"> & { reachability?: Reachability }) { global.__hexConnectRuntime = { reachability: new Reachability(async () => false), ...next }; }
