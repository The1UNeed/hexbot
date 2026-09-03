export interface TunnelProvider { create(slug: string, ingressPort: number): Promise<{ tunnelId: string; token: string; hostname: string }>; delete(tunnelId: string): Promise<void> }

interface CloudflareResult<T> { success: boolean; errors?: Array<{ message: string }>; result: T }

export class CloudflareTunnelProvider implements TunnelProvider {
  constructor(private token: string, private accountId: string, private zoneId: string, private domain: string) {}
  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", ...init.headers } });
    const data = await response.json() as CloudflareResult<T>;
    if (!response.ok || !data.success) throw new Error(data.errors?.[0]?.message ?? `Cloudflare request failed (${response.status})`);
    return data.result;
  }
  async create(slug: string, ingressPort: number) {
    const created = await this.request<{ id: string }>(`/accounts/${this.accountId}/cfd_tunnel`, { method: "POST", body: JSON.stringify({ name: `hexbot-${slug}`, config_src: "cloudflare" }) });
    try {
      await this.request(`/accounts/${this.accountId}/cfd_tunnel/${created.id}/configurations`, { method: "PUT", body: JSON.stringify({ config: { ingress: [{ hostname: `${slug}.connect.${this.domain}`, service: `http://127.0.0.1:${ingressPort}` }, { service: "http_status:404" }] } }) });
      const hostname = `${slug}.connect.${this.domain}`;
      await this.request<{ id: string }>(`/zones/${this.zoneId}/dns_records`, { method: "POST", body: JSON.stringify({ type: "CNAME", name: hostname, content: `${created.id}.cfargotunnel.com`, proxied: true }) });
      const token = await this.request<string>(`/accounts/${this.accountId}/cfd_tunnel/${created.id}/token`, { method: "GET" });
      return { tunnelId: created.id, token, hostname };
    } catch (error) { await this.delete(created.id).catch(() => undefined); throw error; }
  }
  async delete(tunnelId: string) {
    const target = `${tunnelId}.cfargotunnel.com`;
    const records = await this.request<Array<{ id: string }>>(`/zones/${this.zoneId}/dns_records?type=CNAME&content=${encodeURIComponent(target)}`, { method: "GET" });
    for (const record of records) await this.request(`/zones/${this.zoneId}/dns_records/${record.id}`, { method: "DELETE" });
    await this.request(`/accounts/${this.accountId}/cfd_tunnel/${tunnelId}`, { method: "DELETE" });
  }
}

export class FakeTunnelProvider implements TunnelProvider {
  deleted: string[] = [];
  async create(slug: string, _ingressPort: number) { return { tunnelId: `fake-tunnel-${slug}`, token: `fake-tunnel-token-${slug}`, hostname: `${slug}.connect.${process.env.CONNECT_DOMAIN ?? "hexbot.test"}` }; }
  async delete(tunnelId: string) { this.deleted.push(tunnelId); }
}

export const createTunnelProvider = (): TunnelProvider => {
  const { CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID, CONNECT_DOMAIN } = process.env;
  return CF_API_TOKEN && CF_ACCOUNT_ID && CF_ZONE_ID && CONNECT_DOMAIN ? new CloudflareTunnelProvider(CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID, CONNECT_DOMAIN) : new FakeTunnelProvider();
};
