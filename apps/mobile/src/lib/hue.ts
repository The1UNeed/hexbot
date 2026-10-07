/**
 * Stable hue in [0, 360) derived from a name. Used for generated avatars so a
 * bot keeps the same colour everywhere without storing one.
 */
export function hueFromString(value: string): number {
  let hash = 0

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 360_000
  }

  return hash % 360
}
