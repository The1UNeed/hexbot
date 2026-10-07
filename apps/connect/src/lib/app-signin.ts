/** How long an approved app sign-in waits for the app to collect it. */
export const APP_SIGNIN_TTL_MS = 10 * 60_000;
/** RFC 7636 S256 challenge: 32 bytes of SHA-256, base64url without padding. */
export const isChallenge = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** The code the app and the authorize page both show, so a user can tell the request is theirs. The app derives it the same way. */
export function confirmationCode(challenge: string): string {
  const raw = Array.from(Buffer.from(challenge, "base64url").subarray(0, 8), byte => alphabet[byte % alphabet.length]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
