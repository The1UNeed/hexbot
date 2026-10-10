import { describe, it, expect } from 'vitest'
import { StagedFiles } from './staged'
/** A daemon that stages files per session and hands them to the next prompt. */
function daemon() {
  const staged = new Map<string, string[]>()
  const prompts: { text: string; files: string[] }[] = []
  const state = { online: true }
  const call = async (method: string, params: Record<string, unknown>) => {
    if (!state.online) throw new Error('Connect to a daemon first.')
    const session = String(params.session_id)
    if (method === 'attachments.clear') staged.delete(session)
    else if (method === 'prompt.submit') {
      prompts.push({ text: String(params.text), files: staged.get(session) ?? [] })
      staged.delete(session)
    } else staged.set(session, [...(staged.get(session) ?? []), String(params.name)])
    return {}
  }
  return { call, prompts, staged, state }
}
/** The phone's request path: leftovers go before input reaches the daemon. */
function phone(d: ReturnType<typeof daemon>, files: StagedFiles) {
  const clear = (session: string) => d.call('attachments.clear', { session_id: session })
  return {
    rpc: async (method: string, params: Record<string, unknown>) => {
      await files.before('home', method, params, clear)
      return d.call(method, params)
    },
    leave: async () => {
      files.abandon()
      await files.flush('home', clear)
    }
  }
}
describe('staged files', () => {
  it('drops a left draft file that could not be cleared offline before the next message', async () => {
    const d = daemon()
    const files = new StagedFiles()
    const app = phone(d, files)
    await app.rpc('file.attach', { session_id: 's1', name: 'secret.txt' })
    files.uploaded('home', 's1')
    d.state.online = false
    await app.leave()
    expect(files.leftovers('home')).toEqual(['s1'])
    d.state.online = true
    await app.rpc('prompt.submit', { session_id: 's1', text: 'Hello' })
    expect(d.prompts).toEqual([{ text: 'Hello', files: [] }])
    expect(files.leftovers('home')).toEqual([])
  })
  it('does not send while leftover files cannot be cleared', async () => {
    const d = daemon()
    const files = new StagedFiles()
    const app = phone(d, files)
    await app.rpc('file.attach', { session_id: 's1', name: 'secret.txt' })
    files.uploaded('home', 's1')
    files.abandon()
    const offline = phone({ ...d, call: async () => Promise.reject(new Error('timed out')) }, files)
    await expect(offline.rpc('prompt.submit', { session_id: 's1', text: 'Hi' })).rejects.toThrow(
      'Files from an unsent message are still attached. Try again.'
    )
    expect(d.prompts).toEqual([])
    expect(files.leftovers('home')).toEqual(['s1'])
  })
  it('sends the draft its own files and keeps leftovers across restarts', async () => {
    const d = daemon()
    let saved: string[] = []
    const files = new StagedFiles([], held => (saved = held))
    const app = phone(d, files)
    await app.rpc('file.attach', { session_id: 's1', name: 'report.pdf' })
    files.uploaded('home', 's1')
    await app.rpc('prompt.submit', { session_id: 's1', text: 'Read this' })
    files.cleared('home', 's1')
    expect(d.prompts).toEqual([{ text: 'Read this', files: ['report.pdf'] }])
    await app.rpc('file.attach', { session_id: 's2', name: 'secret.txt' })
    files.uploaded('home', 's2')
    // The app quits before the draft is sent; the next launch treats it as left.
    const relaunched = phone(d, new StagedFiles(saved))
    await relaunched.rpc('prompt.submit', { session_id: 's2', text: 'Hi' })
    expect(d.prompts.at(-1)).toEqual({ text: 'Hi', files: [] })
  })
  it('forgets a session the daemon no longer has', async () => {
    const files = new StagedFiles()
    files.uploaded('home', 's1')
    files.abandon()
    await files.flush('home', async () => Promise.reject(new Error('session not found')))
    expect(files.leftovers('home')).toEqual([])
  })
})
