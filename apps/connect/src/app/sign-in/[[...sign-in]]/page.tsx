import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignIn } from "@clerk/nextjs";
import { authMode, currentClerkUserId } from "@/lib/auth";

export const metadata: Metadata = { title: "Sign in" };
export default async function SignInPage() {
  if (await currentClerkUserId()) redirect("/connect");
  return (
    <div className="page narrow">
      <div className="auth">
        <h1 className="display-sm center" style={{ fontSize: "2rem" }}>Sign in to Hexbot Connect</h1>
        {authMode() === "clerk" ? <SignIn /> : <p className="notice">Sign-in is not configured on this instance.</p>}
        <p className="meta center">By signing in you agree to the <a href="https://hexbot.app/terms/">terms</a> and <a href="https://hexbot.app/privacy/">privacy policy</a>.</p>
      </div>
    </div>
  );
}
