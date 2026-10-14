/** Expo's push service; the daemon never talks to it, so it holds no push credentials. */
export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
/** Pushes one daemon may send per minute, counted with registration attempts under a `push:` key. */
export const PUSHES_PER_MINUTE = 10;
export const PUSH_TARGETS_MAX = 20;
export const pushTokenPattern = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,160}\]$/;
/** Daemon-side ids: a section, or the phone's paired device. */
export const daemonIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

export interface PushTarget { token: string; device: string }
export interface PushResult { gone: string[]; failed: number }

/**
 * Wakes the owner's phones about a check-in. The words are Connect's own: a
 * daemon chooses only which section to open and which saved daemon (by the
 * phone's device id) to open it on, so it can neither put chat on Connect nor
 * send its own text through Connect's Expo account. Returns the tokens Expo no
 * longer knows, for the daemon to forget, and how many others failed.
 */
export async function sendCheckinPush(input: { targets: PushTarget[]; section: string }, send: typeof fetch = fetch): Promise<PushResult> {
  const messages = input.targets.map(target => ({ to: target.token, title: "Hexbot", body: "Your primary bot has a message for you.", data: { section: input.section, device: target.device }, sound: "default", priority: "high" }));
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
  if (process.env.EXPO_ACCESS_TOKEN) headers.authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  const response = await send(EXPO_PUSH_URL, { method: "POST", headers, body: JSON.stringify(messages), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Expo push failed with ${response.status}`);
  const reply = await response.json() as { data?: { status?: string; details?: { error?: string } }[] };
  const tickets = reply.data ?? [];
  const gone = tickets.flatMap((ticket, index) => ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered" ? [input.targets[index].token] : []);
  // A ticket missing from the reply counts as failed too.
  const failed = input.targets.length - tickets.filter(ticket => ticket.status === "ok").length - gone.length;
  if (failed > 0) console.warn(`Expo rejected ${failed} check-in push(es): ${[...new Set(tickets.map(t => t.details?.error).filter(Boolean))].join(", ") || "no ticket"}`);
  return { gone, failed };
}
