import { NextResponse } from "next/server";
import { requireClient } from "@/lib/http";
import { daemonStatuses, getStore } from "@/lib/runtime";
// `online` stays for apps that predate `status`; it is true only when the daemon's address answers.
export async function GET(request: Request) { const session = await requireClient(request); if (session instanceof NextResponse) return session; const rows = await getStore().listDaemons(session.userId); const statuses = await daemonStatuses(rows); return NextResponse.json({ daemons: rows.map(d => { const status = statuses.get(d.id) ?? "offline"; return { id: d.id, name: d.name, slug: d.slug, tunnel_hostname: d.tunnelHostname, identity_key: d.identityKey ?? null, online: status === "online", status, last_seen_at: d.lastSeenAt?.toISOString() ?? null }; }) }); }
