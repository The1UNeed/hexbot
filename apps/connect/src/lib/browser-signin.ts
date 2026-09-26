import { daemonOrigin } from "./daemons";
import type { Store } from "./store";
import { hashToken, randomToken } from "./tokens";

/**
 * Browser sign-in to a daemon, the OAuth-shaped half of Connect (docs/connect.md).
 * The daemon's Hermes login route sends the browser here with a PKCE challenge and
 * its callback URL; once the daemon's owner is signed in we hand the browser back
 * with a one-time code, which the daemon exchanges (with its verifier and its own
 * token) for a login grant. Codes are useless to anyone who only sees the URL.
 */
export interface BrowserSignInParams { daemon?: string; state?: string; code_challenge?: string; redirect_uri?: string }
export const GRANT_CODE_TTL_MS = 5 * 60_000;
const challengeShape = /^[A-Za-z0-9_-]{43}$/;

export type BrowserSignInResult =
  | { kind: "invalid"; message: string }
  | { kind: "sign-in"; daemonName: string }
  | { kind: "wrong-account"; daemonName: string }
  | { kind: "redirect"; href: string; daemonName: string };

export async function startBrowserSignIn(
  params: BrowserSignInParams,
  { store, userId, deviceName, fakeTunnels }: { store: Store; userId: string | null; deviceName: string; fakeTunnels: boolean },
): Promise<BrowserSignInResult> {
  const { daemon: daemonId = "", state = "", code_challenge: challenge = "", redirect_uri: redirectUri = "" } = params;
  const daemon = daemonId ? await store.getDaemon(daemonId) : null;
  if (!daemon || daemon.revokedAt) return { kind: "invalid", message: "This daemon is not registered with Connect. Run hexbot connect on it first." };
  if (!state || state.length > 256 || !challengeShape.test(challenge)) return { kind: "invalid", message: "The sign-in request is incomplete. Start again from the daemon." };
  // The code only ever goes back to the daemon's own callback, never to a URL the query names. The daemon
  // builds it from its public hostname; with fake tunnels the loopback form is accepted as well.
  const callbacks = [`https://${daemon.tunnelHostname}/auth/callback`, ...(fakeTunnels ? [`${daemonOrigin(daemon, true)}/auth/callback`] : [])];
  if (!callbacks.includes(redirectUri)) return { kind: "invalid", message: "The sign-in request came from an address that does not belong to this daemon." };
  if (!userId) return { kind: "sign-in", daemonName: daemon.name };
  if (daemon.userId !== userId) return { kind: "wrong-account", daemonName: daemon.name };
  const code = randomToken("hxg_");
  await store.createGrantCode({ codeHash: hashToken(code), daemonId: daemon.id, userId, deviceName, challenge, redirectUri, expiresAt: new Date(Date.now() + GRANT_CODE_TTL_MS) });
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  url.searchParams.set("state", state);
  return { kind: "redirect", href: url.toString(), daemonName: daemon.name };
}
