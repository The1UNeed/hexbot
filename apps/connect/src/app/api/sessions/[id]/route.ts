import { NextResponse } from "next/server";
import { jsonError, requireClient } from "@/lib/http";
import { getStore } from "@/lib/runtime";
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) { const session = await requireClient(request); if (session instanceof NextResponse) return session; const { id } = await context.params; if (!await getStore().revokeClientSession(id, session.userId, new Date())) return jsonError("not_found", "Session not found", 404); return NextResponse.json({ ok: true }); }
