"use client";
import { useState, useTransition } from "react";
import { track } from "@/lib/analytics";
import { revokeSession } from "./actions";

export interface DeviceView { id: string; name: string; created: string; lastSeen: string; current?: boolean }

export function DeviceRow({ device }: { device: DeviceView }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const signOut = () => start(async () => { const result = await revokeSession(device.id); setError(result.error ?? null); if (result.ok) track("connect_device_revoked"); });
  return (
    <li className="list-row">
      <div className="stack" style={{ gap: ".2rem" }}>
        <span className="name">{device.name}</span>
        <span className="meta">Signed in {device.created}, last used {device.lastSeen}</span>
        {error ? <p className="small danger" role="alert">{error}</p> : null}
      </div>
      <div className="actions"><button className="button button-sm button-quiet" disabled={pending} onClick={signOut} type="button">Sign out</button></div>
    </li>
  );
}
