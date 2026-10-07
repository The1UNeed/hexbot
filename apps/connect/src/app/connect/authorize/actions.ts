"use server";

import { APP_SIGNIN_TTL_MS, isChallenge } from "@/lib/app-signin";
import { currentUser } from "@/lib/auth";
import { getStore } from "@/lib/runtime";
import { hashToken, randomToken } from "@/lib/tokens";

export interface AuthorizeResult { error?: string; href?: string; approved?: boolean }

/** Approves the app only on an explicit click; rendering the page never does. */
export async function authorizeClient(_previous: AuthorizeResult, formData: FormData): Promise<AuthorizeResult> {
  const user = await currentUser();
  if (!user) return { error: "Sign in before connecting Hexbot." };
  const state = String(formData.get("state") ?? "");
  const challenge = String(formData.get("challenge") ?? "");
  const device = String(formData.get("device") ?? "").trim().slice(0, 100);
  if (!device || state.length > 256 || (!state && !isChallenge(challenge))) return { error: "The authorization request is invalid or expired." };
  // Current apps poll with the verifier behind `challenge`, so the session reaches the app that asked
  // even when several Hexbot apps on the computer claim hexbot://.
  if (isChallenge(challenge)) {
    try {
      if (await getStore().approveClientAuthorization({ challenge, userId: user.id, deviceName: device, expiresAt: new Date(Date.now() + APP_SIGNIN_TTL_MS) })) return { approved: true };
      return { error: "This sign-in request was already used. Start again in Hexbot." };
    } catch (error) {
      // Before the client_authorizations migration, fall through to the hexbot:// link the app also listens for.
      console.warn("Connect: could not store app authorization, using the hexbot:// link", error);
      if (!state) return { error: "Hex Connect could not finish this sign-in. Try again in a moment." };
    }
  }
  const token = randomToken("hxc_");
  await getStore().createClientSession({ userId: user.id, tokenHash: hashToken(token), deviceName: device });
  return { href: `hexbot://connect?state=${encodeURIComponent(state)}#session=${encodeURIComponent(token)}` };
}
