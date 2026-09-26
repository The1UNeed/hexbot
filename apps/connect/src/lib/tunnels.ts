// Tunnel hostnames sit one label under CONNECT_DOMAIN, a zone of its own (docs/deploy.md), so Cloudflare's
// Universal SSL wildcard certificate covers them; deeper names would not be.
// `kind` rather than instanceof: Next gives pages and route handlers separate module graphs, so the class identity differs.
// Tunnels are locally managed: the daemon's sidecar sets ingress to its own loopback port, and this
// service never sends an ingress config, so a leaked daemon token cannot repoint a tunnel.
export interface TunnelProvider { readonly kind: "cloudflare" | "fake" | "unconfigured"; create(slug: string): Promise<{ tunnelId: string; hostname: string }>; connectorToken(tunnelId: string): Promise<string>; delete(tunnelId: string): Promise<void> }

interface CloudflareResult<T> { success: boolean; errors?: Array<{ message: string }>; result: T }

export class CloudflareTunnelProvider implements TunnelProvider {
  readonly kind = "cloudflare" as const;
  constructor(private token: string, private accountId: string, private zoneId: string, private domain: string) {}
  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", ...init.headers } });
    const data = await response.json() as CloudflareResult<T>;
    if (!response.ok || !data.success) throw new Error(data.errors?.[0]?.message ?? `Cloudflare request failed (${response.status})`);
    return data.result;
  }
  async create(slug: string) {
    const created = await this.request<{ id: string }>(`/accounts/${this.accountId}/cfd_tunnel`, { method: "POST", body: JSON.stringify({ name: `hexbot-${slug}`, config_src: "local" }) });
    try {
      const hostname = `${slug}.${this.domain}`;
      await this.request<{ id: string }>(`/zones/${this.zoneId}/dns_records`, { method: "POST", body: JSON.stringify({ type: "CNAME", name: hostname, content: `${created.id}.cfargotunnel.com`, proxied: true }) });
      return { tunnelId: created.id, hostname };
    } catch (error) { await this.delete(created.id).catch(() => undefined); throw error; }
  }
  /** Fetched when the daemon collects its registration, so no tunnel token is stored here. */
  connectorToken(tunnelId: string) { return this.request<string>(`/accounts/${this.accountId}/cfd_tunnel/${tunnelId}/token`, { method: "GET" }); }
  async delete(tunnelId: string) {
    const target = `${tunnelId}.cfargotunnel.com`;
    const records = await this.request<Array<{ id: string }>>(`/zones/${this.zoneId}/dns_records?type=CNAME&content=${encodeURIComponent(target)}`, { method: "GET" });
    for (const record of records) await this.request(`/zones/${this.zoneId}/dns_records/${record.id}`, { method: "DELETE" });
    await this.request(`/accounts/${this.accountId}/cfd_tunnel/${tunnelId}`, { method: "DELETE" });
  }
}

export class FakeTunnelProvider implements TunnelProvider {
  readonly kind = "fake" as const;
  deleted: string[] = [];
  async create(slug: string) { return { tunnelId: `fake-tunnel-${slug}`, hostname: `${slug}.${process.env.CONNECT_DOMAIN ?? "hexbot.test"}` }; }
  async connectorToken(tunnelId: string) { return `fake-tunnel-token-${tunnelId}`; }
  async delete(tunnelId: string) { this.deleted.push(tunnelId); }
}

/** A production deployment without Cloudflare credentials refuses to register daemons rather than pretend. */
export class UnconfiguredTunnelProvider implements TunnelProvider {
  readonly kind = "unconfigured" as const;
  private fail(): never { throw new Error("Cloudflare tunnel credentials are not configured"); }
  async create(_slug: string): Promise<never> { this.fail(); }
  async connectorToken(): Promise<never> { this.fail(); }
  async delete(): Promise<never> { this.fail(); }
}

export const createTunnelProvider = (): TunnelProvider => {
  const { CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID, CONNECT_DOMAIN } = process.env;
  if (CF_API_TOKEN && CF_ACCOUNT_ID && CF_ZONE_ID && CONNECT_DOMAIN) return new CloudflareTunnelProvider(CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID, CONNECT_DOMAIN);
  // Fake tunnels point every daemon at loopback, which must never happen on a real deployment.
  return process.env.NODE_ENV === "production" ? new UnconfiguredTunnelProvider() : new FakeTunnelProvider();
};
