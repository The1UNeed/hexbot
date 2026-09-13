import { SignInButton } from "@clerk/nextjs";
import { authMode } from "@/lib/auth";

/** Sign-in call to action, or an honest notice when this deployment has no identity provider yet. */
export function SignInPrompt({ children }: { children: React.ReactNode }) {
  if (authMode() === "clerk") return <><p>{children}</p><SignInButton mode="modal"><button>Sign in</button></SignInButton><p className="legal">By signing in you agree to the <a href="https://hexbot.app/terms/">terms</a> and <a href="https://hexbot.app/privacy/">privacy policy</a>.</p></>;
  return <p className="error">Sign-in is not available on this Hexbot Connect instance yet.</p>;
}
