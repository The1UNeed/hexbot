/** The daemon reports Unix seconds; the client works in milliseconds. */
export function toMillis(value: number | null | undefined): number {
  if (!value) {return 0}

  return value < 1e12 ? value * 1000 : value
}
