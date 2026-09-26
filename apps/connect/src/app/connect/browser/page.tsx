import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SignInPrompt } from "../../sign-in-prompt";
import { currentUser } from "@/lib/auth";
import { startBrowserSignIn, type BrowserSignInParams } from "@/lib/browser-signin";
import { deviceNameFromUserAgent } from "@/lib/daemons";
import { fakeTunnels, getStore } from "@/lib/runtime";
import { SignOutLink } from "./sign-out-link";
import { TrackOnce } from "@/components/consent";

export const metadata: Metadata = { title: "Open your daemon" };
export const dynamic = "force-dynamic";

/** The daemon sent the browser here to prove who is signing in; a signed-in owner goes straight back with a one-time code. */
export default async function BrowserSignInPage({ searchParams }: { searchParams: Promise<BrowserSignInParams> }) {
  const params = await searchParams;
  const user = await currentUser();
  const result = await startBrowserSignIn(params, {
    store: getStore(), userId: user?.id ?? null,
    deviceName: deviceNameFromUserAgent((await headers()).get("user-agent")),
    fakeTunnels: fakeTunnels(),
  });
  if (result.kind === "redirect") redirect(result.href);
  const query = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => typeof entry[1] === "string")).toString();
  return (
    <div className="page narrow stack-lg">
      {result.kind === "invalid" ? (
        <>
          <h1 className="display-sm" style={{ fontSize: "2rem" }}>This sign-in link does not work</h1>
          <p className="notice notice-error">{result.message}</p>
        </>
      ) : result.kind === "wrong-account" ? (
        <>
          <h1 className="display-sm" style={{ fontSize: "2rem" }}>{result.daemonName} belongs to another account</h1>
          <p className="notice notice-error">You are signed in to Connect with an account that does not own this daemon. <SignOutLink /> and sign in with the account you registered it under.</p>
        </>
      ) : (
        <>
          <div>
            <h1 className="display-sm" style={{ fontSize: "2rem" }}>Open {result.daemonName}</h1>
            <p className="lede" style={{ marginTop: ".75rem" }}>Sign in to Connect and this browser will be signed in to your daemon.</p>
          </div>
          <SignInPrompt returnTo={`/connect/browser?${query}`} />
          <TrackOnce event="connect_browser_signin_prompted" />
        </>
      )}
    </div>
  );
}
