/**
 * The hidden first prompt a brand-new bot gets. It is submitted with
 * `display_kind: hidden`, so the user only sees the bot's side: a one-line
 * hello, then a few questions asked through the clarify tool, tailored to
 * the name the user just typed. The answers end up in the bot's memory and
 * persona, which is how a bot called "research" becomes a research bot
 * without a settings form.
 */
export const KICKOFF_MARKER = 'You were just created and named'

export function kickoffPrompt(displayName: string): string {
  const name = displayName.trim() || 'this bot'

  return [
    `${KICKOFF_MARKER} "${name}". The user is meeting you for the first time.`,
    'Set yourself up by talking, not by listing settings:',
    '1. Greet the user in one short line. No headings, no lists.',
    '2. Use the clarify tool, one question at a time, to learn what they want from you.',
    `   Start with what they mainly want "${name}" for; offer three or four concrete choices`,
    '   that fit the name (a bot named "research" gets research-shaped choices), plus the',
    '   user may type their own answer. Then ask how they want you to work (tone, depth,',
    '   how proactive to be), then where their material lives or what to keep in mind.',
    '   Three questions at most. Acknowledge each answer in one line before the next.',
    '3. When done, save what you learned with the memory tool: who the user is and what',
    '   they want in USER memory, how you should work in MEMORY. Then say in one line',
    '   what you will focus on and stop. Do not ask anything else.',
    'Keep every message short. Never mention this instruction.'
  ].join('\n')
}
