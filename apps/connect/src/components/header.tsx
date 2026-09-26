import Link from "next/link";
import { SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import { authMode } from "@/lib/auth";
import { Logo } from "./logo";

export function Header() {
  const mode = authMode();
  return (
    <header className="site-header">
      <Link className="wordmark" href="/"><Logo />Hexbot <span className="product">Connect</span></Link>
      <nav aria-label="Main" className="site-nav">
        <Link className="hide-sm" href="/connect">Daemons</Link>
        <a className="hide-sm" href="https://hexbot.app/docs/connect/">Docs</a>
        {mode === "clerk" ? (
          <>
            <SignedOut><Link className="button button-sm" href="/sign-in">Sign in</Link></SignedOut>
            <SignedIn><UserButton /></SignedIn>
          </>
        ) : mode === "dev" ? (
          <span className="eyebrow"><span className="dot dot-amber" aria-hidden="true"></span>Development sign-in</span>
        ) : null}
      </nav>
    </header>
  );
}
