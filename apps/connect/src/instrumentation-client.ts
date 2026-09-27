import { initAnalytics, routeChanged } from "./lib/analytics";

initAnalytics();

export function onRouterTransitionStart(url: string) {
  try { routeChanged(new URL(url, window.location.origin).pathname); } catch { /* a malformed URL is not worth a crash */ }
}
