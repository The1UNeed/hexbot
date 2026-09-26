import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

const withClerk = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? clerkMiddleware() : null;

// The desktop app (origin hexbot-app://app) and LAN browsers served by a daemon
// call the bearer-token API cross-origin, so those routes answer preflights and
// allow any origin. Cookies are never used there.
const isApi = (pathname: string) => pathname.startsWith("/api/") || pathname === "/.well-known/jwks.json";
const cors = (response: Response) => {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "authorization, content-type");
  response.headers.set("Access-Control-Max-Age", "600");
  return response;
};

export default async function proxy(request: NextRequest, event: NextFetchEvent) {
  const api = isApi(request.nextUrl.pathname);
  if (api && request.method === "OPTIONS") return cors(new NextResponse(null, { status: 204 }));
  const response = (withClerk ? await withClerk(request, event) : null) ?? NextResponse.next();
  return api && response instanceof Response ? cors(response) : response;
}
// PostHog traffic (/ingest) and static files skip Clerk.
export const config = { matcher: ["/((?!_next/static|_next/image|ingest|favicon.ico|icon.svg|apple-touch-icon.png|og.png).*)"] };
