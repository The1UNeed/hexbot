import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignUp } from "@clerk/nextjs";
import { authMode, currentClerkUserId } from "@/lib/auth";

export const metadata: Metadata = { title: "Create an account" };
export default async function SignUpPage() {
  if (await currentClerkUserId()) redirect("/connect");
  return (
    <div className="page narrow">
      <div className="auth">
        <h1 className="display-sm center" style={{ fontSize: "2rem" }}>Create your Hexbot account</h1>
        {authMode() === "clerk" ? <SignUp /> : <p className="notice">Sign-up is not configured on this instance.</p>}
        <p className="meta center">By creating an account you agree to the <a href="https://hexbot.app/terms/">terms</a> and <a href="https://hexbot.app/privacy/">privacy policy</a>.</p>
      </div>
    </div>
  );
}
