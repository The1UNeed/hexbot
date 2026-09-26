"use server";

import { currentUser } from "@/lib/auth";
import { getStore } from "@/lib/runtime";
import { hashToken, randomToken } from "@/lib/tokens";

export interface AuthorizeResult { error?: string; href?: string }

/** Mints the app's client session only on an explicit click; rendering the page never does. */
export async function authorizeClient(_previous: AuthorizeResult, formData: FormData): Promise<AuthorizeResult> {
  const user = await currentUser();
  if (!user) return { error: "Sign in before connecting Hexbot." };
  const state = String(formData.get("state") ?? "");
  const device = String(formData.get("device") ?? "").trim().slice(0, 100);
  if (!state || !device || state.length > 256) return { error: "The authorization request is invalid or expired." };
  const token = randomToken("hxc_");
  await getStore().createClientSession({ userId: user.id, tokenHash: hashToken(token), deviceName: device });
  return { href: `hexbot://connect?state=${encodeURIComponent(state)}#session=${encodeURIComponent(token)}` };
}
