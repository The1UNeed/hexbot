import { NextResponse } from "next/server";
import { authMode } from "@/lib/auth";
import { getStore, getTunnels } from "@/lib/runtime";
import { MemoryStore } from "@/lib/store";

export const dynamic = "force-dynamic";
/** Reports which backends this deployment runs on and whether the database has the current migration, so a smoke check can tell a placeholder or an unmigrated database from a working service. */
export async function GET() {
  const store = getStore() instanceof MemoryStore ? "memory" : "neon";
  const tunnels = getTunnels().kind;
  const auth = authMode();
  const signing = process.env.CONNECT_SIGNING_KEY_JWK ? "configured" : "ephemeral";
  const missing = await getStore().missingSchema().catch(error => { console.error("health: schema check failed", error); return null; });
  const schema = missing === null ? "unreachable" : missing.length ? "behind" : "current";
  const ready = store === "neon" && tunnels === "cloudflare" && auth === "clerk" && signing === "configured" && schema === "current";
  return NextResponse.json({ ok: true, ready, store, tunnels, auth, signing, schema, ...(missing?.length ? { missing } : {}), domain: process.env.CONNECT_DOMAIN ?? null });
}
