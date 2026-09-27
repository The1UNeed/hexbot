import type { Metadata } from "next";
import { SignInPrompt } from "../../sign-in-prompt";
import { currentClerkUserId } from "@/lib/auth";
import { AuthorizeForm } from "./authorize-form";

export const metadata: Metadata = { title: "Connect the app" };
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<{ state?: string; device?: string }> }) {
  const userId = await currentClerkUserId();
  const { state, device } = await searchParams;
  if (!state || !device || state.length > 256 || device.length > 100) return (
    <div className="page narrow stack">
      <h1 className="display-sm" style={{ fontSize: "2rem" }}>This link is incomplete</h1>
      <p className="notice notice-error">The authorization link is missing the app&apos;s request. Go back to Hexbot and choose <strong>Sign in with Hex Connect</strong> again.</p>
    </div>
  );
  const returnTo = `/connect/authorize?state=${encodeURIComponent(state)}&device=${encodeURIComponent(device)}`;
  return (
    <div className="page narrow stack-lg">
      <div>
        <h1 className="display-sm" style={{ fontSize: "2rem" }}>Connect the Hexbot app</h1>
        <p className="lede" style={{ marginTop: ".75rem" }}><strong>{device}</strong> wants to use your account to list your daemons and sign in to them.</p>
      </div>
      {userId ? <div className="panel"><AuthorizeForm device={device} state={state} /></div> : <SignInPrompt returnTo={returnTo}>Sign in to connect this app.</SignInPrompt>}
      <p className="notice">Only continue if you started this from Hexbot yourself. You can sign the app out again at any time from your daemons page.</p>
    </div>
  );
}
