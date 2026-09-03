"use client";
import { useState } from "react";
export function ApproveForm({ initialCode = "" }: { initialCode?: string }) {
  const [message, setMessage] = useState(""); const [approved, setApproved] = useState(false);
  async function submit(formData: FormData) { setMessage(""); const response = await fetch("/api/register/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_code: formData.get("code") }) }); const body = await response.json() as { message?: string; name?: string }; setApproved(response.ok); setMessage(response.ok ? `${body.name ?? "Daemon"} is connected. You can return to the terminal.` : body.message ?? "Approval failed"); }
  return <form action={submit}><label>Code<input name="code" defaultValue={initialCode} placeholder="XXXX-XXXX" autoComplete="one-time-code" required /></label><button type="submit" disabled={approved}>{approved ? "Approved" : "Approve daemon"}</button>{message && <p className={approved ? "" : "error"}>{message}</p>}</form>;
}
