import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

const withClerk = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? clerkMiddleware() : null;
export default function proxy(request: NextRequest, event: NextFetchEvent) { return withClerk ? withClerk(request, event) : NextResponse.next(); }
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
