import { describe, expect, it } from "vitest";
import { NextRequest, type NextFetchEvent } from "next/server";
import proxy from "../proxy";

const event = {} as NextFetchEvent;
describe("proxy", () => {
  it("answers API preflights for the desktop app origin", async () => {
    const response = await proxy(new NextRequest("http://localhost/api/daemons", { method: "OPTIONS", headers: { origin: "hexbot-app://app" } }), event);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
  });
  it("adds CORS headers to API and JWKS responses only", async () => {
    const api = await proxy(new NextRequest("http://localhost/.well-known/jwks.json"), event);
    expect(api.headers.get("access-control-allow-origin")).toBe("*");
    const page = await proxy(new NextRequest("http://localhost/connect"), event);
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
  });
});
