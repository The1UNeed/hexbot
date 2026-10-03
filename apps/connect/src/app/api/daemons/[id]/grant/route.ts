import { z } from "zod";
import { NextResponse } from "next/server";
import { requireClient, jsonError } from "@/lib/http";
import { daemonTarget } from "@/lib/daemons";
import { fakeTunnels, getStore } from "@/lib/runtime";
import { issueGrant } from "@/lib/tokens";

const grantInput = z.object({
  jkt: z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine(value =>
    Buffer.from(value, "base64url").toString("base64url") === value
  ).optional(),
});

/** A login grant for the app: it redeems the grant at the daemon's password-login route for a device token. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireClient(request); if (session instanceof NextResponse) return session;
  const { id } = await context.params;
  const daemon = await getStore().getDaemon(id);
  if (!daemon || daemon.revokedAt || daemon.userId !== session.userId) return jsonError("not_found", "Daemon not found", 404);
  // Empty bodies are valid for existing clients; other fields remain ignored.
  let body: unknown;
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return jsonError("invalid_request", "Invalid grant request", 400);
  }
  const input = grantInput.safeParse(body);
  if (!input.success) return jsonError("invalid_request", "Invalid key thumbprint", 400);
  const grant = await issueGrant({
    sub: session.userId,
    daemon_id: daemon.id,
    device_name: session.deviceName,
    ...(input.data.jkt ? { cnf: { jkt: input.data.jkt } } : {}),
  });
  const target = daemonTarget(daemon, fakeTunnels());
  return NextResponse.json({ grant, expires_in: 300, daemon: { id: daemon.id, name: daemon.name, ...target } }, { headers: { "Cache-Control": "no-store" } });
}
