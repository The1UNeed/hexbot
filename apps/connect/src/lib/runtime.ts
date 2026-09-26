import { createStore, type Store } from "./store";
import { createTunnelProvider, type TunnelProvider } from "./tunnels";

// Pages and route handlers are separate module graphs in Next, so module-level
// state would give the authorize page and /api/* different in-memory stores.
// Everything process-wide hangs off globalThis instead.
interface Runtime { store: Store; tunnels: TunnelProvider }
const global = globalThis as typeof globalThis & { __hexbotConnectRuntime?: Runtime };
const runtime = (): Runtime => global.__hexbotConnectRuntime ??= { store: createStore(), tunnels: createTunnelProvider() };
export const getStore = () => runtime().store;
export const getTunnels = () => runtime().tunnels;
/** True when daemons are reached on loopback instead of a tunnel hostname (development, tests). */
export const fakeTunnels = () => getTunnels().kind === "fake";
export function setRuntimeForTests(next: Runtime) { global.__hexbotConnectRuntime = next; }
