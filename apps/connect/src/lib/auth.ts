export async function currentClerkUserId(): Promise<string | null> {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) return process.env.DEV_USER_ID ?? null;
  const { auth } = await import("@clerk/nextjs/server");
  return (await auth()).userId;
}
