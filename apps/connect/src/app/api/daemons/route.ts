import { NextResponse } from "next/server";
import { isOnline } from "@/lib/daemons";
import { requireClient } from "@/lib/http";
import { getStore } from "@/lib/runtime";
export async function GET(request: Request) { const session = await requireClient(request); if (session instanceof NextResponse) return session; const rows = await getStore().listDaemons(session.userId); return NextResponse.json({ daemons: rows.map(d => ({ id: d.id, name: d.name, slug: d.slug, tunnel_hostname: d.tunnelHostname, online: isOnline(d), last_seen_at: d.lastSeenAt?.toISOString() ?? null })) }); }
