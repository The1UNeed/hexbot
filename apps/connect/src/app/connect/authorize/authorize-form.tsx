"use client";
import { useActionState, useEffect } from "react";
import { track } from "@/lib/analytics";
import { authorizeClient, type AuthorizeResult } from "./actions";

const initialState: AuthorizeResult = {};

export function AuthorizeForm({ device, state }: { device: string; state: string }) {
  const [result, action, pending] = useActionState(authorizeClient, initialState);
  useEffect(() => { if (result.href) track("connect_client_authorized"); }, [result.href]);

  // The hexbot:// link carries the app's session token. It stays in React state and is opened
  // from a click, never written into the DOM where autocapture or replay could pick it up.
  if (result.href) return (
    <div className="stack">
      <p className="notice notice-success">{device} is authorized. Return to Hexbot to pick a daemon.</p>
      <div className="row">
        <button className="button ph-no-capture" onClick={() => window.location.assign(result.href!)} type="button">Open Hexbot</button>
      </div>
      <p className="meta">If Hexbot did not open, press the button. The link only works on this computer and this one time.</p>
    </div>
  );
  return (
    <form action={action} className="stack">
      <input name="device" type="hidden" value={device} />
      <input name="state" type="hidden" value={state} />
      <div className="row"><button className="button" disabled={pending} type="submit">{pending ? "Authorizing…" : `Authorize ${device}`}</button></div>
      {result.error ? <p className="notice notice-error" role="alert">{result.error}</p> : null}
    </form>
  );
}
