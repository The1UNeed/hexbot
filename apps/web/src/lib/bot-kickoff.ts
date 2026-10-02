/**
 * The daemon writes a brand-new bot's hidden first prompt (`kickoff_prompt` in
 * `backend/hexbot-core/src/catalog.rs`)
 * and every prompt opens with this marker. Hexbot replays an interrupted
 * hidden kickoff as a plain user turn, so history is filtered by it. Change
 * both together.
 */
export const KICKOFF_MARKER = 'You were just created and named'
