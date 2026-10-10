/** Requests that give a session input; the daemon hands them the files staged on it. */
const INPUT = new Set(['prompt.submit', 'image.attach_bytes', 'pdf.attach', 'file.attach'])
const key = (daemon: string, session: string) => JSON.stringify([daemon, session])
/**
 * Sessions holding files uploaded for a message that was not sent. The daemon
 * attaches staged files to the next message on that session, so files of an
 * abandoned draft stay on record until attachments.clear succeeds, and the
 * session is cleared before it takes any other input.
 */
export class StagedFiles {
  private held: Set<string>
  /** The session whose staged files belong to the draft on screen. */
  private draft: string | null = null
  constructor(
    held: string[] = [],
    private save: (held: string[]) => void = () => {}
  ) {
    this.held = new Set(held)
  }
  private changed() {
    this.save([...this.held])
  }
  /** A file for the draft on this session reached the daemon. */
  uploaded(daemon: string, session: string) {
    this.draft = key(daemon, session)
    this.held.add(this.draft)
    this.changed()
  }
  /** The daemon took the staged files with a message, or they were cleared. */
  cleared(daemon: string, session: string) {
    const k = key(daemon, session)
    if (this.draft === k) this.draft = null
    if (this.held.delete(k)) this.changed()
  }
  /** The draft was left; its files must go before its session takes input again. */
  abandon() {
    this.draft = null
  }
  /** Sessions on this daemon with files left by an abandoned draft. */
  leftovers(daemon: string): string[] {
    return [...this.held].flatMap(k => {
      const [d, session] = JSON.parse(k) as [string, string]
      return d === daemon && k !== this.draft ? [session] : []
    })
  }
  /**
   * Runs before every request. Input for a session with leftover files waits
   * until they are cleared, and fails when they cannot be.
   */
  async before(
    daemon: string,
    method: string,
    params: Record<string, unknown>,
    clear: (session: string) => Promise<unknown>
  ) {
    const session = params.session_id
    if (!INPUT.has(method) || typeof session !== 'string') return
    if (!this.leftovers(daemon).includes(session)) return
    try {
      await clear(session)
    } catch (error) {
      if (!gone(error))
        throw new Error('Files from an unsent message are still attached. Try again.')
    }
    this.cleared(daemon, session)
  }
  /** Tries to clear every leftover on this daemon. What fails stays on record. */
  async flush(daemon: string, clear: (session: string) => Promise<unknown>) {
    for (const session of this.leftovers(daemon))
      try {
        await clear(session)
        this.cleared(daemon, session)
      } catch (error) {
        if (gone(error)) this.cleared(daemon, session)
      }
  }
}
/** A session the daemon no longer has took its staged files with it. */
const gone = (error: unknown) =>
  /session not found/i.test(error instanceof Error ? error.message : String(error))
