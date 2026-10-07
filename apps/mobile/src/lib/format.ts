import { toMillis } from './time'

const DAY = 86_400_000

function startOfDay(ms: number): number {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)

  return date.getTime()
}

/**
 * The roster's time: "15:10" today, "Yesterday", a weekday within the week,
 * then "Sep 19", and the year once it is not this one.
 */
export function rowTime(value: number | null | undefined, now = Date.now()): string {
  const ms = toMillis(value)

  if (!ms) {
    return ''
  }

  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY)
  const date = new Date(ms)

  if (days <= 0) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }

  if (days === 1) {
    return 'Yesterday'
  }

  if (days < 7) {
    return date.toLocaleDateString(undefined, { weekday: 'long' })
  }

  if (date.getFullYear() === new Date(now).getFullYear()) {
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  }

  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** "Today 9:13 PM" style separators between days in a transcript. */
export function dayLabel(value: number, now = Date.now()): string {
  const ms = toMillis(value)
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY)
  const time = new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

  if (days <= 0) {
    return `Today ${time}`
  }

  if (days === 1) {
    return `Yesterday ${time}`
  }

  return `${new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', weekday: 'short' })} ${time}`
}
