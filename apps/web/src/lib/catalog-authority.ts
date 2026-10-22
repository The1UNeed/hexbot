/** Request order, membership authority, and provisional cache restoration for catalogs. */
export type ReadOutcome = 'present' | 'gone' | 'discarded'
export interface CatalogRead {
  identity: object
  order: number
}
interface Entry {
  order: number
  outcome: ReadOutcome
  known: boolean
}

export class CatalogAuthority {
  private identity = {}
  private clock = 0
  private fullList = 0
  private entries = new Map<string, Entry>()

  reset(): void {
    this.identity = {}
    this.clock = this.fullList = 0
    this.entries.clear()
  }

  same(read: CatalogRead): boolean {
    return read.identity === this.identity
  }

  session(): () => boolean {
    const identity = this.identity

    return () => identity === this.identity
  }

  /** Reserve order before a list or mutation RPC, including creates with unknown IDs. */
  request(): CatalogRead {
    return { identity: this.identity, order: ++this.clock }
  }

  read(id: string): CatalogRead {
    const read = this.request()
    this.entries.set(id, {
      order: read.order,
      outcome: 'discarded',
      known: this.entries.get(id)?.known ?? false
    })

    return read
  }

  current(id: string, read: CatalogRead): boolean {
    return this.same(read) && this.entries.get(id)?.order === read.order
  }

  finish(id: string, read: CatalogRead, outcome: ReadOutcome): boolean {
    if (!this.current(id, read)) {
      return false
    }

    return this.commit(id, read, outcome)
  }

  /** A reply keeps its request order; it cannot become newer than an intervening read/event. */
  commit(id: string, read: CatalogRead, outcome: ReadOutcome): boolean {
    const order = this.entries.get(id)?.order ?? this.fullList

    if (!this.same(read) || order > read.order) {
      return false
    }

    this.entries.set(id, { order: read.order, outcome, known: outcome !== 'discarded' })

    return true
  }

  touch(id: string, outcome: ReadOutcome): void {
    this.finish(id, this.read(id), outcome)
  }

  outcome(id: string): ReadOutcome {
    return this.entries.get(id)?.outcome ?? (this.fullList ? 'gone' : 'discarded')
  }

  outcomes(): Record<string, ReadOutcome> {
    return Object.fromEntries([...this.entries].map(([id, entry]) => [id, entry.outcome]))
  }

  capture(id: string): () => boolean {
    const identity = this.identity
    const order = this.entries.get(id)?.order

    return () => identity === this.identity && this.entries.get(id)?.order === order
  }

  cacheRead(): (id: string) => boolean {
    const identity = this.identity
    const orders = new Map([...this.entries].map(([id, entry]) => [id, entry.order]))

    return id =>
      identity === this.identity &&
      !this.fullList &&
      !this.entries.get(id)?.known &&
      this.entries.get(id)?.order === orders.get(id)
  }

  /** Includes pending IDs, even those absent from both memory and the response. */
  list<T>(
    read: CatalogRead,
    rows: T[],
    current: Record<string, T>,
    key: (row: T) => string,
    inScope: (id: string) => boolean = () => true,
    full = true
  ): T[] | null {
    if (!this.same(read) || read.order < this.fullList) {
      return null
    }

    const returned = new Map(rows.map(row => [key(row), row]))
    const applies = (id: string) => inScope(id) && (this.entries.get(id)?.order ?? 0) <= read.order
    const accepted = new Set<string>()

    for (const id of new Set([
      ...this.entries.keys(),
      ...Object.keys(current),
      ...returned.keys()
    ])) {
      if (applies(id)) {
        accepted.add(id)
        this.entries.set(id, {
          order: read.order,
          outcome: returned.has(id) ? 'present' : 'gone',
          known: true
        })
      }
    }

    if (full) {
      this.fullList = read.order
    }

    return [
      ...rows.flatMap(row =>
        accepted.has(key(row)) ? [row] : current[key(row)] ? [current[key(row)]!] : []
      ),
      ...Object.entries(current).flatMap(([id, row]) =>
        !returned.has(id) && !accepted.has(id) ? [row] : []
      )
    ]
  }

  /** A full list may prune disk-only IDs, but never work started after its request. */
  owns(read: CatalogRead, id: string): boolean {
    return (
      this.same(read) &&
      read.order === this.fullList &&
      (this.entries.get(id)?.order ?? 0) <= read.order
    )
  }
}
