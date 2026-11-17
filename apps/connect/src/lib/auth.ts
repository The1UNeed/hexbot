import { getStore } from "./runtime";
import type { User } from "./store";

export async function currentClerkUserId(): Promise<string | null> {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    // DEV_USER_ID stands in for Clerk only in a development build (`next dev`), never in `next build` output on any host.
    return process.env.NODE_ENV === "production" ? null : process.env.DEV_USER_ID ?? null;
  }
  const { auth } = await import("@clerk/nextjs/server");
  return (await auth()).userId;
}

/** The Connect user row for the signed-in Clerk account, or `null` when signed out. */
export async function currentUser(): Promise<User | null> {
  const clerkId = await currentClerkUserId();
  return clerkId ? getStore().getOrCreateUser(clerkId) : null;
}

export const authMode = () => process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? "clerk" : process.env.DEV_USER_ID && process.env.NODE_ENV !== "production" ? "dev" : "none";

/** A `redirect_url` that stays on Connect, or `null` for anything else. It is parsed as a browser would, which drops tabs and newlines and reads `\\` as `/`. */
export function localPath(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  const base = "https://connect.invalid";
  const url = URL.parse(value, base);
  return url?.origin === base ? `${url.pathname}${url.search}${url.hash}` : null;
}

/** Where to send a signed-out visitor so they land back on `returnTo` afterwards. */
export const signInPath = (returnTo: string) => `/sign-in?redirect_url=${encodeURIComponent(returnTo)}`;
