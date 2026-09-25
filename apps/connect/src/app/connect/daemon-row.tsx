"use client";
import { useState, useTransition } from "react";
import { track } from "@/lib/analytics";
import { renameDaemon, revokeDaemon } from "./actions";

export interface DaemonView { id: string; name: string; hostname: string; online: boolean; lastSeen: string; openUrl: string }

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
    if (!window.confirm(`Revoke ${daemon.name}? Its tunnel closes and apps signed in through Connect lose the way in. The daemon keeps working on its own network.`)) return;
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
            <span className={`status${daemon.online ? " online" : ""}`}><span className={`dot${daemon.online ? " dot-online" : ""}`} aria-hidden="true"></span>{daemon.online ? "Online" : `Offline, last seen ${daemon.lastSeen}`}</span>
          </div>
        )}
        <span className="hostname">{daemon.hostname}</span>
        {error ? <p className="small danger" role="alert">{error}</p> : null}
      </div>
      <div className="actions">
        {daemon.online
          ? <a className="button button-sm" href={daemon.openUrl} onClick={() => track("connect_daemon_opened", { how: "browser" })}>Open in browser</a>
          : <button className="button button-sm" disabled title="The daemon has not checked in for a while. Start hexbot serve on it." type="button">Open in browser</button>}
        <button className="button button-sm button-quiet" disabled={pending || editing} onClick={() => setEditing(true)} type="button">Rename</button>
        <button className="button button-sm button-danger" disabled={pending} onClick={revoke} type="button">Revoke</button>
      </div>
    </li>
  );
}
