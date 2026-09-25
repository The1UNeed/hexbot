import type { NextConfig } from "next";

// Clerk's browser script and API live on the Frontend API host: the shared
// dev host while the app runs on Clerk development keys, and clerk.hexbot.app
// in production. Turnstile (bot protection on sign-up) comes from Cloudflare.
const clerkHosts = "https://*.clerk.accounts.dev https://clerk.hexbot.app";
const dev = process.env.NODE_ENV === "development";
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""} ${clerkHosts} https://challenges.cloudflare.com`,
  `connect-src 'self' ${clerkHosts} https://api.clerk.com https://clerk-telemetry.com`,
  `img-src 'self' data: https://img.clerk.com ${clerkHosts}`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  `frame-src https://challenges.cloudflare.com ${clerkHosts}`,
  "worker-src 'self' blob:",
].join("; ");

const config: NextConfig = {
  reactStrictMode: true,
  // posthog-js posts to paths that end in a slash; Next would otherwise 308 them.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    // PostHog through this origin, so the CSP stays 'self' and ad blockers see a first-party request.
    return [
      { source: "/ingest/static/:path*", destination: "https://us-assets.i.posthog.com/static/:path*" },
      { source: "/ingest/:path*", destination: "https://us.i.posthog.com/:path*" },
    ];
  },
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "Content-Security-Policy", value: csp },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    }];
  },
};
export default config;
