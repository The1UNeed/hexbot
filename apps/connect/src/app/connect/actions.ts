"use server";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { revokeDaemonWithTunnel } from "@/lib/revoke";
import { getStore } from "@/lib/runtime";

export interface ActionResult { error?: string; ok?: boolean }

async function ownedDaemon(id: string, allowRevoked = false) {
  const user = await currentUser();
  if (!user) return { error: "Sign in first." } as const;
  const daemon = await getStore().getDaemon(id);
  if (!daemon || daemon.userId !== user.id || (daemon.revokedAt && !allowRevoked)) return { error: "That daemon is not on your account." } as const;
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

/** Revoking invalidates the daemon token and tears down its tunnel; failed cleanup can be retried. */
export async function revokeDaemon(id: string): Promise<ActionResult> {
  const found = await ownedDaemon(id, true);
  if ("error" in found) return found;
  const result = await revokeDaemonWithTunnel(found.daemon);
  revalidatePath("/connect");
  if (result !== "ok") return { error: "The daemon's tunnel could not be deleted. Try again in a moment." };
  return { ok: true };
}

export async function revokeSession(id: string): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return { error: "Sign in first." };
  if (!await getStore().revokeClientSession(id, user.id, new Date())) return { error: "That device is already signed out." };
  revalidatePath("/connect");
  return { ok: true };
}
