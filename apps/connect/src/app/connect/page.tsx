import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser, signInPath } from "@/lib/auth";
import { browserSignInUrl, daemonOrigin, isOnline, relativeTime } from "@/lib/daemons";
import { fakeTunnels, getStore } from "@/lib/runtime";
import { DaemonRow } from "./daemon-row";
import { DeviceRow } from "./device-row";

export const metadata: Metadata = { title: "Your daemons" };
export const dynamic = "force-dynamic";

export default async function ConnectPage() {
  const user = await currentUser();
  if (!user) redirect(signInPath("/connect"));
  const store = getStore();
  const fake = fakeTunnels();
  const now = Date.now();
  const daemons = (await store.listDaemons(user.id)).map(daemon => ({
    id: daemon.id, name: daemon.name, hostname: daemon.tunnelHostname, online: isOnline(daemon, now),
    lastSeen: relativeTime(daemon.lastSeenAt, now), openUrl: browserSignInUrl(daemonOrigin(daemon, fake)),
  }));
  const devices = (await store.listClientSessions(user.id)).map(session => ({
    id: session.id, name: session.deviceName, created: relativeTime(session.createdAt, now), lastSeen: relativeTime(session.lastSeenAt, now),
  }));

  return (
    <div className="page stack-lg">
      <section>
        <div className="section-title">
          <h1 className="display-sm" style={{ fontSize: "2rem" }}>Your daemons</h1>
          <Link className="small" href="/connect/approve">Have a code? Approve a daemon</Link>
        </div>
        {daemons.length === 0 ? (
          <div className="panel stack">
            <p>No daemons are connected to your account yet. On the machine that runs your bots, run:</p>
            <pre className="command">hexbot connect</pre>
            <p className="mute small">It prints an address and an eight-character code. Open the address, sign in, and approve the code. You can also press <strong>Sign in and register</strong> in the app under Settings, Connect.</p>
          </div>
        ) : (
          <ul className="list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {daemons.map(daemon => <DaemonRow daemon={daemon} key={daemon.id} />)}
          </ul>
        )}
        {daemons.length > 0 ? <p className="meta" style={{ marginTop: "1rem" }}>Opening a daemon signs this browser in to it. It appears in that daemon&apos;s Settings under Devices, where you can revoke it later. In the Hexbot app, sign in with the same account and pick a daemon.</p> : null}
      </section>
      <section>
        <div className="section-title">
          <h2 className="display-sm" style={{ fontSize: "1.5rem" }}>Apps signed in with your account</h2>
        </div>
        {devices.length === 0 ? (
          <p className="mute">No apps yet. In the Hexbot app choose <strong>Sign in with Hex Connect</strong> and it will appear here.</p>
        ) : (
          <ul className="list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {devices.map(device => <DeviceRow device={device} key={device.id} />)}
          </ul>
        )}
        <p className="meta" style={{ marginTop: "1rem" }}>Signing an app out here stops it from listing your daemons and asking for new logins. Devices it already paired with a daemon are revoked in that daemon&apos;s Settings.</p>
      </section>
    </div>
  );
}
