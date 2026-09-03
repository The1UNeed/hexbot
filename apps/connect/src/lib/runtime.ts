import { createStore, type Store } from "./store";
import { createTunnelProvider, type TunnelProvider } from "./tunnels";

let store: Store = createStore();
let tunnels: TunnelProvider = createTunnelProvider();
export const getStore = () => store;
export const getTunnels = () => tunnels;
export function setRuntimeForTests(next: { store: Store; tunnels: TunnelProvider }) { store = next.store; tunnels = next.tunnels; }
