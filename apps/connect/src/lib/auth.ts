export async function currentClerkUserId(): Promise<string | null> {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    // DEV_USER_ID stands in for Clerk only in a development build (`next dev`), never in `next build` output on any host.
    return process.env.NODE_ENV === "production" ? null : process.env.DEV_USER_ID ?? null;
  }
  const { auth } = await import("@clerk/nextjs/server");
  return (await auth()).userId;
}

export const authMode = () => process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? "clerk" : process.env.DEV_USER_ID && process.env.NODE_ENV !== "production" ? "dev" : "none";
