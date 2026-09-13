/** Bot handles are Hermes profile names: lowercase, digits, `_` and `-`, up to 64 chars. */
export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Derive a handle from a display name: "Research Scout" -> "research-scout". */
export function toHandle(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64)
}
