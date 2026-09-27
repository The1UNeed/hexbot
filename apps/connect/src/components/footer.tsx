import { Logo } from "./logo";
import { CookiesButton } from "./consent";

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div>
          <a className="wordmark" href="https://hexbot.app/"><Logo />Hexbot</a>
          <p className="footer-blurb">Connect brokers your sign-in and a hostname for each daemon. Your conversations travel straight from your device to your daemon and never pass through it.</p>
        </div>
        <nav aria-label="Footer" className="footer-nav">
          <a href="https://hexbot.app/">hexbot.app</a>
          <a href="https://hexbot.app/docs/connect/">Docs</a>
          <a href="https://hexbot.app/download/">Download</a>
          <a href="https://hexbot.app/terms/">Terms</a>
          <a href="https://hexbot.app/privacy/">Privacy</a>
          <a href="https://hexbot.app/security/">Security</a>
          <a href="https://github.com/The1UNeed/hexbot">GitHub</a>
          <a href="https://app.youform.com/forms/dyhjikit">Contact</a>
          <CookiesButton />
        </nav>
      </div>
    </footer>
  );
}
