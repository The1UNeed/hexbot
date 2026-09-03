import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merge conditional class names, letting later Tailwind utilities win. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

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

export function initialsFromName(value: string): string {
  const words = value.trim().split(/[\s_-]+/).filter(Boolean)

  if (words.length === 0) {
    return '?'
  }

  if (words.length === 1) {
    return (words[0] ?? '').slice(0, 2).toUpperCase()
  }

  return `${(words[0] ?? '').charAt(0)}${(words[1] ?? '').charAt(0)}`.toUpperCase()
}
