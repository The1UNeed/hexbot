import { describe, expect, it, vi } from "vitest";
import { forward } from "@/lib/posthog-proxy";

describe("PostHog proxy", () => {
  it("forwards the event body and client address but never cookies, and drops Set-Cookie on the way back", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://us.i.posthog.com/e/?compression=gzip-js");
      const headers = new Headers(init?.headers);
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("x-forwarded-for")).toBe("203.0.113.9");
      expect(headers.get("content-type")).toBe("text/plain");
      expect(Buffer.from(init?.body as ArrayBuffer).toString()).toBe("payload");
      return new Response("{}", { status: 200, headers: { "content-type": "application/json", "set-cookie": "ph=1; Domain=posthog.com" } });
    });
    const request = new Request("http://localhost/ingest/e/?compression=gzip-js", { method: "POST", body: "payload", headers: { "content-type": "text/plain", cookie: "__session=clerk-secret", authorization: "Bearer x", "x-forwarded-for": "203.0.113.9" } });
    const response = await forward(request, ["e"], fetchImpl as unknown as typeof fetch);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/json");
  });
  it("serves the SDK's static assets from the assets host", async () => {
    const fetchImpl = vi.fn(async (url: string) => { expect(url).toBe("https://us-assets.i.posthog.com/static/array.js"); return new Response("js", { headers: { "content-type": "application/javascript" } }); });
    const response = await forward(new Request("http://localhost/ingest/static/array.js"), ["static", "array.js"], fetchImpl as unknown as typeof fetch);
    expect(await response.text()).toBe("js");
  });
});
