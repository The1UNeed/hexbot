/**
 * `a@b.c, "Lima, Ana" <ana@d.e>; Lima, Ana <ana@d.e>` as one address each,
 * as the daemon splits them: a comma in quotes, or before any address,
 * belongs to a name. The daemon checks each address.
 */
export function splitAddresses(text: string) {
  const parts = ['']
  let quoted = false

  for (const c of text) {
    if (c === '"') {
      quoted = !quoted
    } else if ((c === ',' || c === ';') && !quoted) {
      parts.push('')

      continue
    }

    parts[parts.length - 1] += c
  }

  const out: string[] = []
  let name = ''

  for (const part of parts) {
    if (part.includes('@')) {
      out.push(`${name}${part}`.trim())
      name = ''
    } else if (part.trim()) {
      name += `${part},`
    }
  }

  if (name.trim()) {
    out.push(name.replace(/,$/, '').trim())
  }

  return out
}
