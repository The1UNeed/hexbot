import { NextResponse } from "next/server";

// First-party path for posthog-js. A Next rewrite would forward the whole request, cookies
// included, so PostHog would receive Connect's Clerk session on every event. This handler
// forwards only what PostHog needs and never passes a Set-Cookie back to this origin.
const ASSETS = "https://us-assets.i.posthog.com";
const EVENTS = "https://us.i.posthog.com";
const requestHeaders = ["accept", "content-type", "content-encoding", "user-agent"];
const responseHeaders = ["content-type", "cache-control", "etag", "last-modified"];

export async function forward(request: Request, path: string[], fetchImpl: typeof fetch = fetch) {
  const url = new URL(request.url);
  const base = path[0] === "static" ? ASSETS : EVENTS;
  // PostHog's endpoints end in a slash (/e/, /flags/); the route params lose it, the request path keeps it.
  const upstreamPath = url.pathname.startsWith("/ingest/") ? url.pathname.slice("/ingest".length) : `/${path.join("/")}`;
  const headers = new Headers();
  for (const name of requestHeaders) { const value = request.headers.get(name); if (value) headers.set(name, value); }
  // PostHog derives an approximate location from the client's address (then discards it, per project settings).
  const ip = request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip");
  if (ip) headers.set("x-forwarded-for", ip);
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  const upstream = await fetchImpl(`${base}${upstreamPath}${url.search}`, { method: request.method, headers, body, redirect: "manual" });
  const out = new Headers();
  for (const name of responseHeaders) { const value = upstream.headers.get(name); if (value) out.set(name, value); }
  return new NextResponse(upstream.body, { status: upstream.status, headers: out });
}

