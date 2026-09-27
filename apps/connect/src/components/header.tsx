import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { authMode } from "@/lib/auth";
import { Logo } from "./logo";

// Clerk 7 dropped <SignedIn>/<SignedOut>; the layout already knows the user on the server.
export function Header({ signedIn }: { signedIn: boolean }) {
  const mode = authMode();
  return (
    <header className="site-header">
      <Link className="wordmark" href="/"><Logo />Hexbot <span className="product">Connect</span></Link>
      <nav aria-label="Main" className="site-nav">
        <Link className="hide-sm" href="/connect">Daemons</Link>
        <a className="hide-sm" href="https://hexbot.app/docs/connect/">Docs</a>
        {mode === "clerk" ? (
          signedIn ? <UserButton /> : <Link className="button button-sm" href="/sign-in">Sign in</Link>
        ) : mode === "dev" ? (
          <span className="eyebrow"><span className="dot dot-amber" aria-hidden="true"></span>Development sign-in</span>
        ) : null}
      </nav>
    </header>
  );
}
