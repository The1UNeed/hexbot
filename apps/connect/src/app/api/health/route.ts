import { NextResponse } from "next/server";
import { authMode } from "@/lib/auth";
import { getStore, getTunnels } from "@/lib/runtime";
import { MemoryStore } from "@/lib/store";

export const dynamic = "force-dynamic";
/** Reports which backends this deployment runs on, so a smoke check can tell a placeholder from a configured service. */
export async function GET() {
  const store = getStore() instanceof MemoryStore ? "memory" : "neon";
  const tunnels = getTunnels().kind;
  const auth = authMode();
  const signing = process.env.CONNECT_SIGNING_KEY_JWK ? "configured" : "ephemeral";
  const ready = store === "neon" && tunnels === "cloudflare" && auth === "clerk" && signing === "configured";
  return NextResponse.json({ ok: true, ready, store, tunnels, auth, signing, domain: process.env.CONNECT_DOMAIN ?? null });
}
