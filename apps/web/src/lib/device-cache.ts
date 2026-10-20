/**
 * What this device keeps of a daemon between launches, in IndexedDB: the
 * roster, the history of recently opened sections with the daemon's cursor,
 * and room logs. The app draws from it at once, then asks the daemon only for
 * what changed. Entries live under a scope, one per connection target; a
 * scope that turns out to hold another daemon's data is cleared.
 *
 * Best effort throughout: without IndexedDB, or when a write fails, the app
 * simply syncs everything as before.
 */

import { useConnection } from '../stores/connection'

import type { ConnectionTarget } from './types'

const DB_NAME = 'hexbot.cache'
const STORE = 'entries'

let database: Promise<IDBDatabase | null> | undefined

function db(): Promise<IDBDatabase | null> {
  database ??= new Promise(resolve => {
    if (!globalThis.indexedDB) {
      resolve(null)

      return
    }

    const open = indexedDB.open(DB_NAME, 1)
    open.onupgradeneeded = () => open.result.createObjectStore(STORE)
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => resolve(null)
    open.onblocked = () => resolve(null)
  })

  return database
}

function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T> | void
): Promise<T | undefined> {
  return db().then(
    found =>
      new Promise(resolve => {
        if (!found) {
          resolve(undefined)

          return
        }

        try {
          const tx = found.transaction(STORE, mode)
          const request = work(tx.objectStore(STORE))
          tx.oncomplete = () => resolve(request ? request.result : undefined)
          tx.onerror = () => resolve(undefined)
          tx.onabort = () => resolve(undefined)
        } catch {
          resolve(undefined)
        }
      })
  )
}

/** The scope for a target: the address it is reached at. */
export function cacheScope(target: ConnectionTarget | null): null | string {
  if (!target) {
    return null
  }

  if (target.kind === 'remote') {
    return `remote:${target.host}:${target.port}`
  }

  if (target.origin) {
    return `local:${target.origin}`
  }

  // A browser page came from the daemon itself; Electron's local daemon is the one in its home.
  return typeof window !== 'undefined' && window.location.protocol.startsWith('http')
    ? `local:${window.location.origin}`
    : 'local'
}

/** The scope of the daemon this page is connected to, or about to connect to. */
export function activeCacheScope(): null | string {
  return cacheScope(useConnection.getState().target)
}

export function readCache<T>(scope: null | string, key: string): Promise<T | undefined> {
  if (!scope) {
    return Promise.resolve(undefined)
  }

  return run<T>('readonly', store => store.get([scope, key]) as IDBRequest<T>)
}

export async function writeCache(scope: null | string, key: string, value: unknown): Promise<void> {
  if (scope) {
    await run('readwrite', store => void store.put(value, [scope, key]))
  }
}

export async function deleteCache(scope: null | string, key: string): Promise<void> {
  if (scope) {
    await run('readwrite', store => void store.delete([scope, key]))
  }
}

/** Forget everything kept for `scope`. */
export async function clearCache(scope: null | string): Promise<void> {
  if (scope) {
    await run('readwrite', store => void store.delete(IDBKeyRange.bound([scope], [scope, []])))
  }
}

/** A section's history as the daemon sent it, and the cursor to ask for what came after. */
export interface CachedHistory<Row = unknown> {
  cursor: string
  rows: Row[]
}

/** How many sections keep their history on the device. */
export const CACHED_SECTIONS = 50

const RECENT_KEY = 'sections:recent'
let writes = Promise.resolve()

/** Keep a section's history, and drop the least recently opened beyond `CACHED_SECTIONS`. */
export function rememberHistory(
  scope: null | string,
  id: string,
  history: CachedHistory
): Promise<void> {
  writes = writes.then(async () => {
    const recent = [
      id,
      ...((await readCache<string[]>(scope, RECENT_KEY)) ?? []).filter(item => item !== id)
    ]

    await writeCache(scope, `section:${id}`, history)
    await writeCache(scope, RECENT_KEY, recent.slice(0, CACHED_SECTIONS))

    for (const evicted of recent.slice(CACHED_SECTIONS)) {
      await deleteCache(scope, `section:${evicted}`)
    }
  })

  return writes
}

export function cachedHistory<Row>(
  scope: null | string,
  id: string
): Promise<CachedHistory<Row> | undefined> {
  return readCache<CachedHistory<Row>>(scope, `section:${id}`)
}

export function forgetHistory(scope: null | string, id: string): Promise<void> {
  writes = writes.then(async () => {
    const recent = (await readCache<string[]>(scope, RECENT_KEY)) ?? []

    await deleteCache(scope, `section:${id}`)

    if (recent.includes(id)) {
      await writeCache(
        scope,
        RECENT_KEY,
        recent.filter(item => item !== id)
      )
    }
  })

  return writes
}

/** Close the database and forget it, so tests start clean. */
export async function resetDeviceCacheForTests(): Promise<void> {
  ;(await database)?.close()
  database = undefined
  writes = Promise.resolve()
}
