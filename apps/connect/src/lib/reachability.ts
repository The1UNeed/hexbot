import { randomBytes } from "node:crypto";
import { identityHost, verifyIdentity } from "./daemon-identity";
import type { Daemon } from "./store";
import { daemonOrigin } from "./daemons";

/**
 * A daemon counts as online only when its address answers. Connect keeps no
 * background record of daemons: heartbeats no longer reach the database, so it
 * can scale to zero between the requests people make (docs/connect.md,
 * "Online state").
 *
 * - `online`: the address answers and, when a key is known, proves the daemon's identity.
 * - `offline`: anything else. A stopped daemon and a broken tunnel look the same from here.
 */
export type DaemonStatus = "online" | "offline";
export const PROBE_TIMEOUT_MS = 3_000;
/** A daemon's providers list is a few hundred bytes; anything larger is not a daemon. */
export const PROBE_BODY_LIMIT = 64 * 1024;
/** A reachable answer holds for a while; an unreachable one is re-checked soon, so a daemon that just came up is not shown down for long. */
export const PROBE_CACHE_MS = 30_000;
export const PROBE_NEGATIVE_CACHE_MS = 5_000;

/** Answers whether an origin serves a daemon. Must never send credentials. */
export type Probe = (origin: string, identity?: Pick<Daemon, "id" | "identityKey">) => Promise<boolean>;

/** The body up to `limit` bytes, or null once it grows past that (the rest is not read). */
async function boundedText(response: Response, limit: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Known keys require a fresh signature. Older registrations use `/api/auth/providers`.
 * Redirects are not followed: a tunnel that answers with someone else's page is not a daemon.
 */
export const probeOrigin: Probe = async (origin, identity) => {
  const nonce = randomBytes(32).toString("base64url");
  const path = identity?.identityKey ? `/api/connect/identity?nonce=${nonce}` : "/api/auth/providers";
  let answered = false;
  const invalid = () => {
    if (identity?.identityKey) console.warn("Connect: invalid daemon identity response", identity.id);
    return false;
  };
  try {
    const response = await fetch(`${origin}${path}`, { method: "GET", redirect: "manual", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    answered = true;
    // A non-2xx answer, such as Cloudflare's 530 for a tunnel with no connector, is just "not answering".
    if (!response.ok) return false;
    const text = await boundedText(response, PROBE_BODY_LIMIT);
    if (text === null) return invalid();
    const body = JSON.parse(text) as { providers?: unknown };
    if (identity?.identityKey) {
      const valid = verifyIdentity(body, identity.id, identity.identityKey, identityHost(origin), nonce);
      if (!valid) return invalid();
      return true;
    }
    return Array.isArray(body?.providers);
  } catch {
    return answered ? invalid() : false;
  }
};

type Probed = Pick<Daemon, "id" | "tunnelHostname" | "ingressPort" | "identityKey">;

/** Probes daemons in parallel and remembers each answer briefly, so a page and its API calls do not probe twice. */
export class Reachability {
  private cache = new Map<string, { at: number; reachable: boolean }>();
  constructor(private probe: Probe, private ttlMs = PROBE_CACHE_MS, private negativeTtlMs = PROBE_NEGATIVE_CACHE_MS) {}

  async reachable(origin: string, now = Date.now(), identity?: Pick<Daemon, "id" | "identityKey">): Promise<boolean> {
    const cacheKey = `${origin}\n${identity?.id ?? ""}\n${identity?.identityKey ?? ""}`;
    const cached = this.cache.get(cacheKey);
    if (cached && now - cached.at < (cached.reachable ? this.ttlMs : this.negativeTtlMs)) return cached.reachable;
    const reachable = await this.probe(origin, identity).catch(() => false);
    this.cache.set(cacheKey, { at: now, reachable });
    return reachable;
  }

  async statuses(daemons: Probed[], fakeTunnels: boolean, now = Date.now()): Promise<Map<string, DaemonStatus>> {
    const result = new Map<string, DaemonStatus>();
    await Promise.all(daemons.map(async daemon => {
      result.set(daemon.id, await this.reachable(daemonOrigin(daemon, fakeTunnels), now, daemon) ? "online" : "offline");
    }));
    return result;
  }
}
