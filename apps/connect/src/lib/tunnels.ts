import { randomUUID, timingSafeEqual } from "node:crypto";
import { tunnelSecret } from "./tokens";

// Tunnel hostnames sit one label under CONNECT_DOMAIN, a zone of its own (docs/deploy.md), so Cloudflare's
// Universal SSL wildcard certificate covers them; deeper names would not be.
// `kind` rather than instanceof: Next gives pages and route handlers separate module graphs, so the class identity differs.
// Tunnels are locally managed: the daemon's sidecar sets ingress to its own loopback port, and this
// service never sends an ingress config, so a leaked daemon token cannot repoint a tunnel.
export interface TunnelInfo { name: string; createdAt: Date; deletedAt: Date | null }
export interface TunnelProvider {
  readonly kind: "cloudflare" | "fake" | "unconfigured";
  /** A tunnel for a new daemon, with its hostname pointed at it. */
  create(slug: string): Promise<{ tunnelId: string; hostname: string }>;
  connectorToken(tunnelId: string): Promise<string>;
  /** The tunnel and every DNS record pointing at it (revocation). */
  delete(tunnelId: string, hostname?: string): Promise<void>;
  /** The tunnel as Cloudflare sees it, or null when it no longer exists at all. */
  inspect(tunnelId: string): Promise<TunnelInfo | null>;
  /** A bare tunnel; `pointHostname` binds a name to it. */
  createTunnel(name: string): Promise<{ tunnelId: string }>;
  /** Make `hostname` resolve to the tunnel, changing the existing record rather than adding one. */
  pointHostname(hostname: string, tunnelId: string): Promise<void>;
  /** The tunnel only; DNS records stay, they may point elsewhere by now. */
  deleteTunnel(tunnelId: string): Promise<void>;
}
/** Every creation has a distinct name, including replacements for the same slug. */
export const tunnelName = (slug: string) => `hexbot-${slug}-${randomUUID()}`;

/** Deleted tunnels retain their names in Cloudflare, so an old credential can recover a lost response. */
export async function verifyTunnelProof(provider: TunnelProvider, token: unknown, daemon: { tunnelId: string; slug: string }): Promise<string | null> {
  let proof: { a: string; t: string; s: string };
  try {
    if (typeof token !== "string" || token.length > 4096) return null;
    proof = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
    if (!proof || typeof proof.a !== "string" || !proof.a || typeof proof.t !== "string" || !/^[0-9a-f-]{36}$/i.test(proof.t) || typeof proof.s !== "string") return null;
  } catch { return null; }
  const tunnel = await provider.inspect(proof.t);
  if (!tunnel || (proof.t !== daemon.tunnelId && !tunnel.name.startsWith(`hexbot-${daemon.slug}-`))) return null;
  const secret = Buffer.from(proof.s, "base64");
  const expected = await tunnelSecret(tunnel.name);
  return secret.length === expected.length && timingSafeEqual(secret, expected) ? proof.t : null;
}

/** One repair per daemon per this long, claimed before any Cloudflare call. */
export const TUNNEL_REPAIR_COOLDOWN_MS = 2 * 60_000;

interface CloudflareResult<T> { success: boolean; errors?: Array<{ message: string }>; result: T }
class CloudflareError extends Error { constructor(message: string, readonly status: number) { super(message); } }

export class CloudflareTunnelProvider implements TunnelProvider {
  readonly kind = "cloudflare" as const;
  constructor(private token: string, private accountId: string, private zoneId: string, private domain: string) {}
  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", ...init.headers } });
    const data = await response.json() as CloudflareResult<T>;
    if (!response.ok || !data.success) throw new CloudflareError(data.errors?.[0]?.message ?? `Cloudflare request failed (${response.status})`, response.status);
    return data.result;
  }
  async create(slug: string) {
    const created = await this.createTunnel(tunnelName(slug));
    try {
      const hostname = `${slug}.${this.domain}`;
      await this.pointHostname(hostname, created.tunnelId);
      return { tunnelId: created.tunnelId, hostname };
    } catch (error) { await this.deleteTunnel(created.tunnelId).catch(() => undefined); throw error; }
  }
  /** Fetched when the daemon collects its registration, so no tunnel token is stored here. */
  connectorToken(tunnelId: string) { return this.request<string>(`/accounts/${this.accountId}/cfd_tunnel/${tunnelId}/token`, { method: "GET" }); }
  async delete(tunnelId: string, hostname?: string) {
    await this.deleteTunnel(tunnelId);
    const target = `${tunnelId}.cfargotunnel.com`;
    const records = await this.request<Array<{ id: string }>>(`/zones/${this.zoneId}/dns_records?type=CNAME&${hostname ? `name=${encodeURIComponent(hostname)}` : `content=${encodeURIComponent(target)}`}`, { method: "GET" });
    for (const record of records) await this.deleteRecord(record.id);
  }
  async inspect(tunnelId: string) {
    try {
      const tunnel = await this.request<{ name: string; created_at: string; deleted_at: string | null }>(`/accounts/${this.accountId}/cfd_tunnel/${tunnelId}`, { method: "GET" });
      return { name: tunnel.name, createdAt: new Date(tunnel.created_at), deletedAt: tunnel.deleted_at ? new Date(tunnel.deleted_at) : null };
    } catch (error) { if (error instanceof CloudflareError && error.status === 404) return null; throw error; }
  }
  async createTunnel(name: string) {
    const created = await this.request<{ id: string }>(`/accounts/${this.accountId}/cfd_tunnel`, { method: "POST", body: JSON.stringify({ name, config_src: "local", tunnel_secret: (await tunnelSecret(name)).toString("base64") }) });
    return { tunnelId: created.id };
  }
  async pointHostname(hostname: string, tunnelId: string) {
    const content = `${tunnelId}.cfargotunnel.com`;
    const records = await this.request<Array<{ id: string; content: string }>>(`/zones/${this.zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`, { method: "GET" });
    if (records.some(record => record.content === content)) return;
    const existing = records[0];
    if (existing) await this.request(`/zones/${this.zoneId}/dns_records/${existing.id}`, { method: "PATCH", body: JSON.stringify({ content, proxied: true }) });
    else await this.request(`/zones/${this.zoneId}/dns_records`, { method: "POST", body: JSON.stringify({ type: "CNAME", name: hostname, content, proxied: true }) });
  }
  private async deleteRecord(id: string) {
    try { await this.request(`/zones/${this.zoneId}/dns_records/${id}`, { method: "DELETE" }); }
    catch (error) { if (!(error instanceof CloudflareError && error.status === 404)) throw error; }
  }
  async deleteTunnel(tunnelId: string) {
    const tunnel = await this.inspect(tunnelId);
    if (!tunnel || tunnel.deletedAt) return;
    try { await this.request(`/accounts/${this.accountId}/cfd_tunnel/${tunnelId}`, { method: "DELETE" }); }
    catch (error) {
      // Another cleanup may have deleted it after our read. Do not swallow a live-tunnel failure.
      const after = await this.inspect(tunnelId);
      if (after && !after.deletedAt) throw error;
    }
  }
}

export class FakeTunnelProvider implements TunnelProvider {
  readonly kind = "fake" as const;
  deleted: string[] = [];
  /** Every tunnel ever created, as `inspect` reports it; tests edit `createdAt` and `deletedAt`. */
  tunnels = new Map<string, TunnelInfo & { secret: string }>();
  /** Which tunnel each hostname points at. */
  hostnames = new Map<string, string>();
  async create(slug: string) {
    const { tunnelId } = await this.createTunnel(tunnelName(slug));
    const hostname = `${slug}.${process.env.CONNECT_DOMAIN ?? "hexbot.test"}`;
    this.hostnames.set(hostname, tunnelId);
    return { tunnelId, hostname };
  }
  async connectorToken(tunnelId: string) { return Buffer.from(JSON.stringify({ a: "fake-account", t: tunnelId, s: this.tunnels.get(tunnelId)!.secret })).toString("base64"); }
  async delete(tunnelId: string, hostname?: string) { await this.deleteTunnel(tunnelId); for (const [host, id] of this.hostnames) if (hostname ? host === hostname : id === tunnelId) this.hostnames.delete(host); }
  async inspect(tunnelId: string) { return this.tunnels.get(tunnelId) ?? null; }
  async createTunnel(name: string) { const tunnelId = randomUUID(); this.tunnels.set(tunnelId, { name, secret: (await tunnelSecret(name)).toString("base64"), createdAt: new Date(), deletedAt: null }); return { tunnelId }; }
  async pointHostname(hostname: string, tunnelId: string) { this.hostnames.set(hostname, tunnelId); }
  async deleteTunnel(tunnelId: string) { this.deleted.push(tunnelId); const info = this.tunnels.get(tunnelId); if (info) info.deletedAt = new Date(); }
}

/** A production deployment without Cloudflare credentials refuses to register daemons rather than pretend. */
export class UnconfiguredTunnelProvider implements TunnelProvider {
  readonly kind = "unconfigured" as const;
  private fail(): never { throw new Error("Cloudflare tunnel credentials are not configured"); }
  async create(_slug: string): Promise<never> { this.fail(); }
  async connectorToken(): Promise<never> { this.fail(); }
  async delete(): Promise<never> { this.fail(); }
  async inspect(): Promise<never> { this.fail(); }
  async createTunnel(): Promise<never> { this.fail(); }
  async pointHostname(): Promise<never> { this.fail(); }
  async deleteTunnel(): Promise<never> { this.fail(); }
}

export const createTunnelProvider = (): TunnelProvider => {
  const { CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID, CONNECT_DOMAIN } = process.env;
  if (CF_API_TOKEN && CF_ACCOUNT_ID && CF_ZONE_ID && CONNECT_DOMAIN) return new CloudflareTunnelProvider(CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID, CONNECT_DOMAIN);
  // Fake tunnels point every daemon at loopback, which must never happen on a real deployment.
  return process.env.NODE_ENV === "production" ? new UnconfiguredTunnelProvider() : new FakeTunnelProvider();
};
