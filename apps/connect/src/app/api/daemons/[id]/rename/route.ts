import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, parseJson, requireClient } from "@/lib/http";
import { getStore } from "@/lib/runtime";
const schema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { const session = await requireClient(request); if (session instanceof NextResponse) return session; const body = await parseJson(request, schema); if (body instanceof NextResponse) return body; const { id } = await context.params; const daemon = await getStore().getDaemon(id); if (!daemon || daemon.userId !== session.userId || daemon.revokedAt) return jsonError("not_found", "Daemon not found", 404); await getStore().renameDaemon(id, body.name); return NextResponse.json({ ok: true }); }
