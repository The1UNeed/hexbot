/** Bounded personal data, usable only by a freshly authorized daemon connection. */
import { useConnection } from '../stores/connection'

import type { ConnectionTarget } from './types'

const STORE = 'entries'
let database: Promise<IDBDatabase | null> | undefined
let generation = 0
let active: CacheAccess | null = null
let writes = Promise.resolve()

export interface CacheAccess {
  scope: string
  daemon: string
  generation: number
}

function db(): Promise<IDBDatabase | null> {
  database ??= new Promise(resolve => {
    if (!globalThis.indexedDB) {
      return resolve(null)
    }

    const request = indexedDB.open('hexbot.cache', 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = request.onblocked = () => resolve(null)
  })

  return database
}

async function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T> | void,
  current: () => boolean = () => true
): Promise<T | undefined> {
  const found = await db()

  if (!found || !current()) {
    return undefined
  }

  return new Promise(resolve => {
    try {
      const tx = found.transaction(STORE, mode)
      const request = work(tx.objectStore(STORE))
      tx.oncomplete = () => resolve(current() && request ? request.result : undefined)
      tx.onerror = tx.onabort = () => resolve(undefined)
    } catch {
      resolve(undefined)
    }
  })
}

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

  return typeof window !== 'undefined' && window.location.protocol.startsWith('http')
    ? `local:${window.location.origin}`
    : 'local'
}

export function activeCacheScope(): null | string {
  return cacheScope(useConnection.getState().target)
}

export function cacheAccess(scope = activeCacheScope()): CacheAccess | null {
  return active?.scope === scope ? active : null
}

export function cacheCurrent(access: CacheAccess | null): boolean {
  return access !== null && active === access && access.generation === generation
}

function queue(work: () => Promise<void>): Promise<void> {
  writes = writes.catch(() => undefined).then(work)

  return writes
}

/** Invalidate queued reads, writes and history fetches synchronously. */
export function suspendCache(): void {
  generation++
  active = null
}

/** Called only after gateway authorization and a successful hexbot.info. */
export async function authorizeCache(
  scope: null | string,
  daemon: string | null | undefined,
  current: () => boolean
): Promise<boolean> {
  suspendCache()
  const mine = generation

  if (!scope || !daemon) {
    return false
  }

  const valid = () => mine === generation && current()
  await queue(async () => {
    const identity = await run<string>('readonly', store => store.get([scope, 'identity']), valid)

    if (!valid()) {
      return
    }

    // Old caches predate authorization gating and have no identity key.
    if (identity !== daemon) {
      await run(
        'readwrite',
        store => void store.delete(IDBKeyRange.bound([scope], [scope, []])),
        valid
      )
    }

    await run('readwrite', store => void store.put(daemon, [scope, 'identity']), valid)

    if (valid()) {
      active = { scope, daemon, generation: mine }
    }
  })

  return valid() && active?.scope === scope
}

/** Revoke first, then delete after any already-started transaction. */
export function revokeCache(scope: null | string): Promise<void> {
  suspendCache()

  return queue(async () => {
    if (scope) {
      await run('readwrite', store => void store.delete(IDBKeyRange.bound([scope], [scope, []])))
    }
  })
}

export function readCache<T>(scope: null | string, key: string): Promise<T | undefined> {
  if (!scope) {
    return Promise.resolve(undefined)
  }

  const access = cacheAccess(scope)

  return run<T>(
    'readonly',
    store => store.get([scope, key]) as IDBRequest<T>,
    () => cacheCurrent(access)
  )
}

export function writeCache(
  scope: null | string,
  key: string,
  value: unknown,
  valid: () => boolean = () => true
): Promise<void> {
  if (!scope) {
    return Promise.resolve()
  }

  const access = cacheAccess(scope)

  return queue(async () => {
    await run(
      'readwrite',
      store => void store.put(value, [scope, key]),
      () => cacheCurrent(access) && valid()
    )
  })
}

/** Prune persisted IDs too, including rooms removed while this client was offline. */
export function pruneRoomLogs(
  scope: null | string,
  roomIds: string[],
  valid: () => boolean = () => true
): Promise<void> {
  if (!scope) {
    return Promise.resolve()
  }

  const access = cacheAccess(scope)
  const keep = new Set(roomIds.map(id => `room:${id}`))

  return queue(async () => {
    await run(
      'readwrite',
      store => {
        const request = store.openKeyCursor(
          IDBKeyRange.bound([scope, 'room:'], [scope, 'room:\uffff'])
        )

        request.onsuccess = () => {
          const cursor = request.result

          if (cursor && cacheCurrent(access) && valid()) {
            if (!keep.has((cursor.key as string[])[1]!)) {
              store.delete(cursor.key)
            }

            cursor.continue()
          }
        }
      },
      () => cacheCurrent(access) && valid()
    )
  })
}

export interface CachedHistory<Row = unknown> {
  rows: Row[]
}
export const CACHED_SECTIONS = 50
export const HISTORY_ROWS = 500
export const HISTORY_BYTES = 512 * 1024
const RECENT_KEY = 'sections:recent'

/** A recent suffix; one oversized row cannot consume the storage budget. */
export function boundedHistory<Row>(rows: Row[]): Row[] {
  let bytes = 2
  const kept: Row[] = []

  for (const row of rows.slice(-HISTORY_ROWS).reverse()) {
    const size = new TextEncoder().encode(JSON.stringify(row)).length + 1

    if (bytes + size > HISTORY_BYTES) {
      break
    }

    bytes += size
    kept.push(row)
  }

  return kept.reverse()
}

export function rememberHistory(
  scope: null | string,
  id: string,
  history: CachedHistory,
  valid: () => boolean = () => true
): Promise<void> {
  if (!scope) {
    return Promise.resolve()
  }

  const access = cacheAccess(scope)
  // Bound before queuing so pending writes cannot retain entire forever chats.
  const rows = boundedHistory(history.rows)

  return queue(async () => {
    const current = () => cacheCurrent(access) && valid()
    const read = await run<string[]>('readonly', store => store.get([scope, RECENT_KEY]), current)

    if (!current()) {
      return
    }

    const recent = [id, ...(read ?? []).filter(item => item !== id)]
    await run(
      'readwrite',
      store => {
        store.put({ rows }, [scope, `section:${id}`])
        store.put(recent.slice(0, CACHED_SECTIONS), [scope, RECENT_KEY])

        for (const evicted of recent.slice(CACHED_SECTIONS)) {
          store.delete([scope, `section:${evicted}`])
        }
      },
      current
    )
  })
}

export function cachedHistory<Row>(
  scope: null | string,
  id: string
): Promise<CachedHistory<Row> | undefined> {
  return readCache<CachedHistory<Row>>(scope, `section:${id}`)
}

export function forgetHistory(scope: null | string, id: string): Promise<void> {
  if (!scope) {
    return Promise.resolve()
  }

  const access = cacheAccess(scope)

  return queue(async () => {
    const current = () => cacheCurrent(access)
    const recent = await run<string[]>('readonly', store => store.get([scope, RECENT_KEY]), current)
    await run(
      'readwrite',
      store => {
        store.delete([scope, `section:${id}`])
        store.put(
          (recent ?? []).filter(item => item !== id),
          [scope, RECENT_KEY]
        )
      },
      current
    )
  })
}

/** Prune disk-only histories too, preserving IDs superseding the list request. */
export function pruneHistories(
  scope: null | string,
  keepIds: string[],
  removable: (id: string) => boolean
): Promise<void> {
  if (!scope) {
    return Promise.resolve()
  }

  const access = cacheAccess(scope)
  const keep = new Set(keepIds)
  const current = () => cacheCurrent(access)
  const removed = (id: string) => !keep.has(id) && removable(id)

  return queue(async () => {
    await run(
      'readwrite',
      store => {
        const recent = store.get([scope, RECENT_KEY])

        recent.onsuccess = () => {
          if (current()) {
            store.put(
              ((recent.result ?? []) as string[]).filter(id => !removed(id)),
              [scope, RECENT_KEY]
            )
          }
        }

        const request = store.openKeyCursor(
          IDBKeyRange.bound([scope, 'section:'], [scope, 'section:\uffff'])
        )

        request.onsuccess = () => {
          const cursor = request.result

          if (cursor && current()) {
            const id = (cursor.key as string[])[1]!.slice('section:'.length)

            if (removed(id)) {
              store.delete(cursor.key)
            }

            cursor.continue()
          }
        }
      },
      current
    )
  })
}

/** A complete read/fetch/commit is serialized per authorized daemon and chat. */
const syncing = new Map<string, Promise<unknown>>()

export function syncHistory<T>(
  access: CacheAccess | null,
  id: string,
  work: () => Promise<T>
): Promise<T> {
  const key = JSON.stringify([access?.scope, access?.generation, id])

  const previous = syncing.get(key)

  const request = (previous ? previous.catch(() => undefined).then(work) : work()).finally(() => {
    if (syncing.get(key) === request) {
      syncing.delete(key)
    }
  })

  syncing.set(key, request)

  return request
}

export async function resetDeviceCacheForTests(): Promise<void> {
  suspendCache()
  await writes
  ;(await database)?.close()
  database = undefined
  syncing.clear()
}
