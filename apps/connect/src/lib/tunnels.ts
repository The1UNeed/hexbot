// Tunnel hostnames sit one label under CONNECT_DOMAIN, a zone of its own (docs/deploy.md), so Cloudflare's
// Universal SSL wildcard certificate covers them; deeper names would not be.
// `kind` rather than instanceof: Next gives pages and route handlers separate module graphs, so the class identity differs.
// Tunnels are locally managed: the daemon's sidecar sets ingress to its own loopback port, and this
// service never sends an ingress config, so a leaked daemon token cannot repoint a tunnel.
export interface TunnelInfo { createdAt: Date; deletedAt: Date | null }
export interface TunnelProvider {
  readonly kind: "cloudflare" | "fake" | "unconfigured";
  /** A tunnel for a new daemon, with its hostname pointed at it. */
  create(slug: string): Promise<{ tunnelId: string; hostname: string }>;
  connectorToken(tunnelId: string): Promise<string>;
  /** The tunnel and every DNS record pointing at it (revocation). */
  delete(tunnelId: string): Promise<void>;
  /** The tunnel as Cloudflare sees it, or null when it no longer exists at all. */
  inspect(tunnelId: string): Promise<TunnelInfo | null>;
  /** A bare tunnel; `pointHostname` binds a name to it. */
  createTunnel(name: string): Promise<{ tunnelId: string }>;
  /** Make `hostname` resolve to the tunnel, changing the existing record rather than adding one. */
  pointHostname(hostname: string, tunnelId: string): Promise<void>;
  /** The tunnel only; DNS records stay, they may point elsewhere by now. */
  deleteTunnel(tunnelId: string): Promise<void>;
}
/** One repair per daemon per this long, claimed in the database before any Cloudflare call. */
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
    const created = await this.createTunnel(`hexbot-${slug}`);
    try {
      const hostname = `${slug}.${this.domain}`;
      await this.pointHostname(hostname, created.tunnelId);
      return { tunnelId: created.tunnelId, hostname };
    } catch (error) { await this.deleteTunnel(created.tunnelId).catch(() => undefined); throw error; }
  }
  /** Fetched when the daemon collects its registration, so no tunnel token is stored here. */
  connectorToken(tunnelId: string) { return this.request<string>(`/accounts/${this.accountId}/cfd_tunnel/${tunnelId}/token`, { method: "GET" }); }
  async delete(tunnelId: string) {
    const target = `${tunnelId}.cfargotunnel.com`;
    const records = await this.request<Array<{ id: string }>>(`/zones/${this.zoneId}/dns_records?type=CNAME&content=${encodeURIComponent(target)}`, { method: "GET" });
    for (const record of records) await this.request(`/zones/${this.zoneId}/dns_records/${record.id}`, { method: "DELETE" });
    await this.deleteTunnel(tunnelId);
  }
  async inspect(tunnelId: string) {
    try {
      const tunnel = await this.request<{ created_at: string; deleted_at: string | null }>(`/accounts/${this.accountId}/cfd_tunnel/${tunnelId}`, { method: "GET" });
      return { createdAt: new Date(tunnel.created_at), deletedAt: tunnel.deleted_at ? new Date(tunnel.deleted_at) : null };
    } catch (error) { if (error instanceof CloudflareError && error.status === 404) return null; throw error; }
  }
  async createTunnel(name: string) {
    const created = await this.request<{ id: string }>(`/accounts/${this.accountId}/cfd_tunnel`, { method: "POST", body: JSON.stringify({ name, config_src: "local" }) });
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
  async deleteTunnel(tunnelId: string) { await this.request(`/accounts/${this.accountId}/cfd_tunnel/${tunnelId}`, { method: "DELETE" }); }
}

export class FakeTunnelProvider implements TunnelProvider {
  readonly kind = "fake" as const;
  deleted: string[] = [];
  /** Every tunnel ever created, as `inspect` reports it; tests edit `createdAt` and `deletedAt`. */
  tunnels = new Map<string, TunnelInfo>();
  /** Which tunnel each hostname points at. */
  hostnames = new Map<string, string>();
  async create(slug: string) {
    const tunnelId = `fake-tunnel-${slug}`; const hostname = `${slug}.${process.env.CONNECT_DOMAIN ?? "hexbot.test"}`;
    this.tunnels.set(tunnelId, { createdAt: new Date(), deletedAt: null }); this.hostnames.set(hostname, tunnelId);
    return { tunnelId, hostname };
  }
  async connectorToken(tunnelId: string) { return `fake-tunnel-token-${tunnelId}`; }
  async delete(tunnelId: string) { for (const [hostname, id] of this.hostnames) if (id === tunnelId) this.hostnames.delete(hostname); await this.deleteTunnel(tunnelId); }
  async inspect(tunnelId: string) { return this.tunnels.get(tunnelId) ?? null; }
  async createTunnel(name: string) { const tunnelId = `fake-${name}`; this.tunnels.set(tunnelId, { createdAt: new Date(), deletedAt: null }); return { tunnelId }; }
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
