import type { Daemon } from "./store";

/** A daemon counts as online while heartbeats keep arriving (they are five minutes apart). */
export const ONLINE_WINDOW_MS = 10 * 60_000;
export const isOnline = (daemon: Pick<Daemon, "lastSeenAt">, now = Date.now()) =>
  !!daemon.lastSeenAt && now - daemon.lastSeenAt.getTime() < ONLINE_WINDOW_MS;

/**
 * Where browsers and apps reach a daemon. Through Cloudflare that is its tunnel
 * hostname over TLS. With the fake tunnel provider (development, tests) the
 * hostname resolves nowhere, so the daemon's own loopback port stands in for
 * it, which is where the tunnel would forward anyway.
 */
export function daemonOrigin(daemon: Pick<Daemon, "tunnelHostname" | "ingressPort">, fakeTunnels: boolean) {
  return fakeTunnels ? `http://127.0.0.1:${daemon.ingressPort}` : `https://${daemon.tunnelHostname}`;
}

export function daemonTarget(daemon: Pick<Daemon, "tunnelHostname" | "ingressPort">, fakeTunnels: boolean) {
  return fakeTunnels
    ? { host: "127.0.0.1", port: daemon.ingressPort, tls: false }
    : { host: daemon.tunnelHostname, port: 443, tls: true };
}

/** The daemon's own sign-in route for the Connect provider; it comes back to `/` once signed in. */
export const browserSignInUrl = (origin: string) => `${origin}/auth/login?provider=connect&next=%2F`;

/** "Safari on iPhone": enough for the owner to recognise a session in the daemon's device list. */
export function deviceNameFromUserAgent(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS"
    : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export function relativeTime(date: Date | null, now = Date.now()): string {
  if (!date) return "never";
  const minutes = Math.round((now - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
