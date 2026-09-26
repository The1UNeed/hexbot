"use client";
import Link from "next/link";
import { useState } from "react";
import { track } from "@/lib/analytics";

/** Codes are shown as XXXX-XXXX; accept them typed with or without the dash, in any case. */
export const normalizeCode = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(.{4})(.{0,4}).*$/, (_, a, b) => (b ? `${a}-${b}` : a));

export function ApproveForm({ initialCode = "" }: { initialCode?: string }) {
  const [code, setCode] = useState(normalizeCode(initialCode));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [approved, setApproved] = useState<{ name: string; hostname: string } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/register/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_code: code }) });
      const body = await response.json() as { message?: string; name?: string; hostname?: string };
      if (response.ok) { setApproved({ name: body.name ?? "Daemon", hostname: body.hostname ?? "" }); track("connect_daemon_approved"); }
      else setError(body.message ?? "Approval failed.");
    } catch { setError("Connect could not be reached. Try again."); }
    finally { setBusy(false); }
  }

  if (approved) return (
    <div className="stack">
      <p className="notice notice-success"><strong>{approved.name}</strong>&nbsp;is connected. Its address is <code>{approved.hostname}</code>. You can close this tab and return to the terminal or the app.</p>
      <div className="row"><Link className="button" href="/connect">Your daemons</Link></div>
    </div>
  );
  return (
    <form className="stack" onSubmit={submit}>
      <label>Code<input autoComplete="one-time-code" autoFocus inputMode="text" maxLength={9} name="code" onChange={event => setCode(normalizeCode(event.target.value))} placeholder="XXXX-XXXX" required spellCheck={false} style={{ fontFamily: "var(--font-mono)", fontSize: "1.5rem", letterSpacing: ".18em", textTransform: "uppercase" }} type="text" value={code} /></label>
      <div className="row"><button className="button" disabled={busy || code.length < 9} type="submit">{busy ? "Approving…" : "Approve daemon"}</button></div>
      {error ? <p className="notice notice-error" role="alert">{error}</p> : null}
    </form>
  );
}
