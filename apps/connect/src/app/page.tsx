import Link from "next/link";
import { redirect } from "next/navigation";
import { currentClerkUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

const steps = [
  ["Register a daemon", "Run hexbot connect on the machine that runs your bots, or press Sign in and register in the app's Connect settings, then approve the code here."],
  ["Sign in anywhere", "Use the same account in the Hexbot app on another computer, or right here in a browser."],
  ["Talk to your bots", "Open a daemon and you are in your rooms and sections. Chat goes straight from your device to your daemon through its tunnel."],
] as const;

export default async function Home() {
  if (await currentClerkUserId()) redirect("/connect");
  return (
    <div className="page">
      <section className="hero">
        <span className="eyebrow"><span className="dot dot-amber" aria-hidden="true"></span>Free during the beta</span>
        <h1 className="display">Your Hexbot, from anywhere.</h1>
        <p className="lede">Sign in once and reach the daemon on your own machine from the app or a browser, without opening a port. Connect brokers your identity and a hostname. Your conversations never pass through it.</p>
        <div className="cta">
          <Link className="button button-lg" href="/sign-in">Sign in</Link>
          <Link className="button button-lg button-quiet" href="/sign-up">Create an account</Link>
        </div>
        <p className="meta" style={{ marginTop: "1.25rem" }}>You never need Connect on your own network. <a href="https://hexbot.app/docs/pairing-and-lan/">Pairing</a> and <a href="https://hexbot.app/docs/tailscale/">Tailscale</a> work without it.</p>
      </section>
      <section>
        <ol className="steps">
          {steps.map(([title, text], index) => (
            <li className="step" key={title}><span className="step-number">{index + 1}</span><strong>{title}</strong><span>{text}</span></li>
          ))}
        </ol>
      </section>
      <section className="narrow center" style={{ marginTop: "3rem" }}>
        <h2 className="display-sm" style={{ fontSize: "1.6rem" }}>What Connect holds, and what it never sees</h2>
        <p className="mute" style={{ marginTop: ".75rem" }}>Your sign-in identity, the names and hostnames of your daemons, hashed tokens, and the devices that signed in. Never your conversations, memory, files, or provider keys. Read the <a href="https://hexbot.app/privacy/#connect">privacy policy</a> or <a href="https://hexbot.app/docs/connect/#self-host-connect">run your own instance</a>: Connect is AGPL software like the rest of Hexbot.</p>
      </section>
    </div>
  );
}
