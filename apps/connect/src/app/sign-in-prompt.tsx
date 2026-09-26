import { SignIn } from "@clerk/nextjs";
import { authMode } from "@/lib/auth";

/**
 * The sign-in card, rendered in place so the page's state (a device name, a
 * daemon code, a PKCE request) survives the round trip: Clerk brings the
 * visitor straight back to `returnTo`.
 */
export function SignInPrompt({ returnTo, children }: { returnTo: string; children?: React.ReactNode }) {
  const mode = authMode();
  if (mode === "clerk") return <div className="auth">{children ? <p className="lede center">{children}</p> : null}<SignIn forceRedirectUrl={returnTo} signUpForceRedirectUrl={returnTo} /></div>;
  if (mode === "dev") return <p className="notice">This development instance signs everyone in as <code>{process.env.DEV_USER_ID}</code>. Reload to continue.</p>;
  return <p className="notice notice-error">Sign-in is not available on this Hex Connect instance yet. The operator has not configured an identity provider.</p>;
}
