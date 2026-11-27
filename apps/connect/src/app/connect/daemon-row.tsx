"use client";
import { useState, useTransition } from "react";
import { track } from "@/lib/analytics";
import type { DaemonStatus } from "@/lib/reachability";
import { renameDaemon, revokeDaemon } from "./actions";

export interface DaemonView { removing?: boolean; id: string; name: string; hostname: string; status: DaemonStatus; openUrl: string }

// No "last seen" time: it moves only while someone looks at this page, so it can be days older than the daemon's last moment online.
export const statusLabel = (daemon: DaemonView) =>
  daemon.removing ? "Removing…" : daemon.status === "online" ? "Online" : "Offline";
const openHint = "The daemon is not answering at its address. Start hexbot serve on it, and check the machine's network if it is already running.";

export function DaemonRow({ daemon }: { daemon: DaemonView }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(daemon.name);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () => start(async () => {
    const result = await renameDaemon(daemon.id, name);
    setError(result.error ?? null);
    if (result.ok) { setEditing(false); track("connect_daemon_renamed"); }
  });
  const revoke = () => {
    if (!daemon.removing && !window.confirm(`Revoke ${daemon.name}? Its tunnel closes and apps signed in through Connect lose the way in. Hexbot on the current version disconnects within about ten minutes of its tunnel being deleted; older versions stop working but keep the setting until you disconnect them. The daemon keeps working on its own network.`)) return;
    start(async () => { const result = await revokeDaemon(daemon.id); setError(result.error ?? null); if (result.ok) track("connect_daemon_revoked"); });
  };

  return (
    <li className="list-row">
      <div className="stack" style={{ gap: ".35rem" }}>
        {editing ? (
          <form className="row" onSubmit={event => { event.preventDefault(); save(); }}>
            <input aria-label="Daemon name" autoFocus maxLength={100} onChange={event => setName(event.target.value)} style={{ maxWidth: "20rem" }} type="text" value={name} />
            <button className="button button-sm" disabled={pending} type="submit">Save</button>
            <button className="button button-sm button-quiet" onClick={() => { setEditing(false); setName(daemon.name); }} type="button">Cancel</button>
          </form>
        ) : (
          <div className="row" style={{ gap: ".75rem" }}>
            <span className="name">{daemon.name}</span>
            <span className={`status${daemon.status === "online" ? " online" : ""}`}><span className={`dot${daemon.status === "online" ? " dot-online" : ""}`} aria-hidden="true"></span>{statusLabel(daemon)}</span>
          </div>
        )}
        <span className="hostname">{daemon.hostname}</span>
        {daemon.removing
          ? <p className="meta">Revoked, but its tunnel is not removed yet. Retry to finish.</p>
          : daemon.status === "online" ? null : <p className="meta">{openHint}</p>}
        {error ? <p className="small danger" role="alert">{error}</p> : null}
      </div>
      <div className="actions">
        {!daemon.removing && (daemon.status === "online"
          ? <a className="button button-sm" href={daemon.openUrl} onClick={() => track("connect_daemon_opened", { how: "browser" })}>Open in browser</a>
          : <button className="button button-sm" disabled type="button">Open in browser</button>)}
        {!daemon.removing && <button className="button button-sm button-quiet" disabled={pending || editing} onClick={() => setEditing(true)} type="button">Rename</button>}
        <button className="button button-sm button-danger" disabled={pending} onClick={revoke} type="button">{daemon.removing ? "Retry" : "Revoke"}</button>
      </div>
    </li>
  );
}
