"use server";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { getStore, getTunnels } from "@/lib/runtime";

export interface ActionResult { error?: string; ok?: boolean }

async function ownedDaemon(id: string) {
  const user = await currentUser();
  if (!user) return { error: "Sign in first." } as const;
  const daemon = await getStore().getDaemon(id);
  if (!daemon || daemon.userId !== user.id || daemon.revokedAt) return { error: "That daemon is not on your account." } as const;
  return { daemon, user } as const;
}

export async function renameDaemon(id: string, name: string): Promise<ActionResult> {
  const found = await ownedDaemon(id);
  if ("error" in found) return found;
  const trimmed = name.trim().slice(0, 100);
  if (!trimmed) return { error: "A daemon needs a name." };
  await getStore().renameDaemon(found.daemon.id, trimmed);
  revalidatePath("/connect");
  return { ok: true };
}

/** Revoking forgets the daemon's token and tears down its tunnel; the daemon keeps working on its own network. */
export async function revokeDaemon(id: string): Promise<ActionResult> {
  const found = await ownedDaemon(id);
  if ("error" in found) return found;
  await getStore().revokeDaemon(found.daemon.id, new Date());
  try { await getTunnels().delete(found.daemon.tunnelId); } catch { revalidatePath("/connect"); return { error: "The daemon was revoked, but its tunnel could not be deleted yet. Try again later." }; }
  revalidatePath("/connect");
  return { ok: true };
}

export async function revokeSession(id: string): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return { error: "Sign in first." };
  if (!await getStore().revokeClientSession(id, user.id, new Date())) return { error: "That device is already signed out." };
  revalidatePath("/connect");
  return { ok: true };
}
