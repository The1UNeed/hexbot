import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignIn } from "@clerk/nextjs";
import { authMode, currentClerkUserId, localPath } from "@/lib/auth";

export const metadata: Metadata = { title: "Sign in" };
/**
 * Clerk itself goes back to `redirect_url` after signing in, through its own steps (MFA, SSO callback),
 * which drop the query, so this sets no forced address. Someone already signed in goes there at once
 * when it is a Connect address, otherwise to /connect.
 */
export default async function SignInPage({ searchParams }: { searchParams: Promise<{ redirect_url?: string | string[] }> }) {
  const returnTo = localPath((await searchParams).redirect_url) ?? "/connect";
  if (await currentClerkUserId()) redirect(returnTo);
  return (
    <div className="page narrow">
      <div className="auth">
        <h1 className="display-sm center" style={{ fontSize: "2rem" }}>Sign in to Hex Connect</h1>
        {authMode() === "clerk" ? <SignIn /> : <p className="notice">Sign-in is not configured on this instance.</p>}
        <p className="meta center">By signing in you agree to the <a href="https://hexbot.app/terms/">terms</a> and <a href="https://hexbot.app/privacy/">privacy policy</a>.</p>
      </div>
    </div>
  );
}
