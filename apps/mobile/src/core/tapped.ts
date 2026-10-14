import type { PushTarget } from './push'

/** The web build has no push notifications; see tapped.native.ts. */
export function useTappedSection(): (PushTarget & { key: string }) | null {
  return null
}

export function clearTapped(): void {}
