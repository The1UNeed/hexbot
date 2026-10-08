/** Times are epoch milliseconds. Daemon fields in seconds need `* 1000` first. */

const DAY = 86_400_000

function startOfDay(ms: number) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)

  return date.getTime()
}

/** A row's time: "8:41 AM" today, "Yesterday", a weekday this week, else "Mar 3". */
export function formatListTime(ms: null | number | undefined, now = Date.now()) {
  if (!ms) {
    return ''
  }

  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY)

  if (days <= 0) {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }

  if (days === 1) {
    return 'Yesterday'
  }

  if (days < 7) {
    return new Date(ms).toLocaleDateString([], { weekday: 'long' })
  }

  return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' })
}

/** A divider between days in a chat: "Today 8:00 AM", "Yesterday 6:12 PM", "Mar 3, 9:30 AM". */
export function formatDayDivider(ms: number, now = Date.now()) {
  const time = new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY)

  if (days <= 0) {
    return `Today ${time}`
  }

  if (days === 1) {
    return `Yesterday ${time}`
  }

  return `${new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`
}

/** "Seen 5 minutes ago" style text for devices and daemons. */
export function formatAgo(ms: null | number | undefined, now = Date.now()) {
  if (!ms) {
    return 'Never'
  }

  const minutes = Math.round((now - ms) / 60_000)

  if (minutes < 1) {
    return 'Just now'
  }

  if (minutes < 60) {
    return `${minutes} min ago`
  }

  const hours = Math.round(minutes / 60)

  if (hours < 24) {
    return `${hours} h ago`
  }

  return formatListTime(ms, now)
}

/** When something runs next: "at 8:00 AM" today, "tomorrow at 8:00 AM", else "on Mar 3". */
export function formatNextRun(ms: null | number | undefined, now = Date.now()) {
  if (!ms) {
    return ''
  }

  const time = new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / DAY)

  if (days <= 0) {
    return `at ${time}`
  }

  if (days === 1) {
    return `tomorrow at ${time}`
  }

  if (days < 7) {
    return `${new Date(ms).toLocaleDateString([], { weekday: 'long' })} at ${time}`
  }

  return `on ${new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' })}`
}
