import type { Metadata } from "next";
import { SignInPrompt } from "../../sign-in-prompt";
import { confirmationCode, isChallenge } from "@/lib/app-signin";
import { currentClerkUserId } from "@/lib/auth";
import { AuthorizeForm } from "./authorize-form";

export const metadata: Metadata = { title: "Connect the app" };
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<{ state?: string; device?: string; challenge?: string }> }) {
  const userId = await currentClerkUserId();
  const { state = "", device, challenge: rawChallenge } = await searchParams;
  // Apps from before app sign-in polling send only `state`.
  const challenge = rawChallenge && isChallenge(rawChallenge) ? rawChallenge : undefined;
  if ((!state && !challenge) || !device || state.length > 256 || device.length > 100) return (
    <div className="page narrow stack">
      <h1 className="display-sm" style={{ fontSize: "2rem" }}>This link is incomplete</h1>
      <p className="notice notice-error">The authorization link is missing the app&apos;s request. Go back to Hexbot and choose <strong>Sign in with Hex Connect</strong> again.</p>
    </div>
  );
  const returnTo = `/connect/authorize?state=${encodeURIComponent(state)}&device=${encodeURIComponent(device)}${challenge ? `&challenge=${challenge}` : ""}`;
  return (
    <div className="page narrow stack-lg">
      <div>
        <h1 className="display-sm" style={{ fontSize: "2rem" }}>Connect the Hexbot app</h1>
        <p className="lede" style={{ marginTop: ".75rem" }}><strong>{device}</strong> wants to use your account to list your daemons and sign in to them.</p>
        {challenge ? <p className="lede" style={{ marginTop: ".75rem" }}>Hexbot shows the code <strong className="ph-no-capture">{confirmationCode(challenge)}</strong>. Continue only if it matches.</p> : null}
      </div>
      {userId ? <div className="panel"><AuthorizeForm challenge={challenge} device={device} state={state} /></div> : <SignInPrompt returnTo={returnTo}>Sign in to connect this app.</SignInPrompt>}
      <p className="notice">Only continue if you started this from Hexbot yourself. You can sign the app out again at any time from your daemons page.</p>
    </div>
  );
}
