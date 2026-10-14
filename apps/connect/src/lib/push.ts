/** Expo's push service; the daemon never talks to it, so it holds no push credentials. */
export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
/** Pushes one daemon may send per minute, counted with registration attempts under a `push:` key. */
export const PUSHES_PER_MINUTE = 10;
export const PUSH_TOKENS_MAX = 20;
export const pushTokenPattern = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,160}\]$/;

/**
 * Wakes the owner's phones about a check-in. The daemon sends the bot's name
 * and the section to open, never the message: chat stays off Connect.
 * Returns the tokens Expo no longer knows, for the daemon to forget.
 */
export async function sendCheckinPush(input: { tokens: string[]; bot: string; section: string }, send: typeof fetch = fetch): Promise<string[]> {
  const messages = input.tokens.map(to => ({ to, title: input.bot, body: "Messaged you from a check-in", data: { section: input.section }, sound: "default", priority: "high" }));
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
  if (process.env.EXPO_ACCESS_TOKEN) headers.authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  const response = await send(EXPO_PUSH_URL, { method: "POST", headers, body: JSON.stringify(messages), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Expo push failed with ${response.status}`);
  const reply = await response.json() as { data?: { status?: string; details?: { error?: string } }[] };
  return (reply.data ?? []).flatMap((ticket, index) => ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered" ? [input.tokens[index]] : []);
}
