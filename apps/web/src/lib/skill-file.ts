/**
 * A skill's SKILL.md as the user writes it in Settings, Plugins: a
 * description and instructions, or a file they load. Pure, so the mobile
 * app writes skills the same way.
 */

/** A SKILL.md from a description and instructions. JSON strings are valid YAML. */
export function skillContent(description: string, instructions: string): string {
  return `---\ndescription: ${JSON.stringify(description.trim())}\n---\n\n${instructions.trim()}\n`
}

/** The `name` a loaded SKILL.md gives itself, if it is one Hexbot accepts. */
export function skillFileName(content: string): string {
  const front = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? ''
  const name = /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(front)?.[1] ?? ''

  return /^[a-z0-9_-]{1,64}$/.test(name) ? name : ''
}
