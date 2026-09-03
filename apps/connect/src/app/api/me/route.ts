import { NextResponse } from "next/server";
import { requireClient } from "@/lib/http";
import { getStore } from "@/lib/runtime";
export async function GET(request: Request) { const session = await requireClient(request); if (session instanceof NextResponse) return session; return NextResponse.json({ user: { id: session.userId }, session: { id: session.id, device_name: session.deviceName }, sessions: (await getStore().listClientSessions(session.userId)).map(s => ({ id: s.id, device_name: s.deviceName, created_at: s.createdAt.toISOString(), last_seen_at: s.lastSeenAt?.toISOString() ?? null })) }); }
