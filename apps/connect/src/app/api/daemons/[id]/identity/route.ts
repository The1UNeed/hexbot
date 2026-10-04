import { NextResponse } from "next/server";
import { z } from "zod";
import { identityKeySchema } from "@/lib/daemon-identity";
import { jsonError, parseJson, requireDaemon } from "@/lib/http";
import { getStore, getTunnels } from "@/lib/runtime";
import { verifyTunnelProof } from "@/lib/tunnels";

const schema = z.object({ public_key: identityKeySchema, tunnel_token: z.string() });
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const daemon = await requireDaemon(request); if (daemon instanceof NextResponse) return daemon;
  const { id } = await context.params;
  if (daemon.id !== id) return jsonError("forbidden", "The daemon token does not match this daemon", 403);
  const body = await parseJson(request, schema); if (body instanceof NextResponse) return body;
  const store = getStore();
  try {
    if (!await verifyTunnelProof(getTunnels(), body.tunnel_token, daemon)) return jsonError("forbidden", "Tunnel credentials are required", 403);
  } catch {
    console.warn("Connect: could not verify tunnel credentials for identity enrollment", id);
    return jsonError("identity_proof_unavailable", "Tunnel credentials could not be checked; try again later", 502);
  }
  try {
    const saved = await store.enrollDaemonIdentity(id, body.public_key);
    const current = await store.getDaemon(id);
    if (!current || current.revokedAt) return jsonError("daemon_revoked", "This daemon was revoked in Hex Connect", 410);
    if (!saved) return jsonError("identity_conflict", "The daemon identity key has changed; run hexbot connect again", 409);
    return NextResponse.json({ ok: true });
  } catch {
    console.warn("Connect: could not enroll daemon identity key", id);
    return jsonError("identity_unavailable", "The daemon identity key could not be saved; try again later", 503);
  }
}
