"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { consent, decide, identify, projectKey, reset, subscribe, track, type Choice } from "@/lib/analytics";

const useConsent = () => useSyncExternalStore(subscribe, consent, () => null);

/** The cookie notice: shown until the visitor answers, reopened from the footer. Rendered only when a PostHog key is configured. */
export function ConsentNotice() {
  const choice = useConsent();
  const [open, setOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); return subscribe(() => setOpen(false)); }, []);
  useEffect(() => { const handler = () => setOpen(true); window.addEventListener("hexbot:cookies", handler); return () => window.removeEventListener("hexbot:cookies", handler); }, []);
  if (!projectKey() || !hydrated || (choice !== null && !open)) return null;
  const answer = (next: Choice) => { decide(next); setOpen(false); };
  return (
    <div className="consent" role="region" aria-label="Cookies">
      <p>Can we count your visit? PostHog sets a cookie and records how you use Connect, with anything you type hidden. <a href="https://hexbot.app/privacy/#connect">Privacy</a></p>
      {choice ? <p className="meta" style={{ marginTop: ".5rem" }}>{choice === "granted" ? "You accepted." : "You declined."}</p> : null}
      <div className="row">
        <button className="button button-sm" type="button" onClick={() => answer("granted")}>Accept</button>
        <button className="button button-sm button-quiet" type="button" onClick={() => answer("denied")}>Decline</button>
      </div>
    </div>
  );
}

export function CookiesButton() {
  if (!projectKey()) return null;
  return <button type="button" onClick={() => window.dispatchEvent(new Event("hexbot:cookies"))}>Cookies</button>;
}

/** Ties this browser's events to the signed-in account (with consent) or forgets it after sign-out. */
export function Identity({ userId }: { userId: string | null }) {
  useEffect(() => { if (userId) identify(userId); else reset(); }, [userId]);
  return null;
}

/** Fire one product event when a page reaches a milestone (a daemon approved, an app authorized). */
export function TrackOnce({ event }: { event: string }) {
  useEffect(() => { track(event); }, [event]);
  return null;
}
