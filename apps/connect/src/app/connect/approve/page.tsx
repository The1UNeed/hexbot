import type { Metadata } from "next";
import { SignInPrompt } from "../../sign-in-prompt";
import { currentClerkUserId } from "@/lib/auth";
import { ApproveForm } from "./approve-form";

export const metadata: Metadata = { title: "Approve a daemon" };
export default async function ApprovePage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const userId = await currentClerkUserId();
  const { code = "" } = await searchParams;
  const returnTo = `/connect/approve${code ? `?code=${encodeURIComponent(code)}` : ""}`;
  return (
    <div className="page narrow stack-lg">
      <div>
        <h1 className="display-sm" style={{ fontSize: "2rem" }}>Approve a daemon</h1>
        <p className="lede" style={{ marginTop: ".75rem" }}>A daemon asked to join your account. Check that the code matches the one shown by <code>hexbot connect</code> or the app, then approve it.</p>
      </div>
      {userId ? <div className="panel"><ApproveForm initialCode={code} /></div> : <SignInPrompt returnTo={returnTo}>Sign in to approve this daemon.</SignInPrompt>}
      <p className="notice">Only approve a code you started yourself. Approving gives that machine a hostname on your account and lets your devices sign in to it.</p>
    </div>
  );
}
