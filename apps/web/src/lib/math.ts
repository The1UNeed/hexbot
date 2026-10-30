/** Fenced blocks (closed or still streaming), inline code and link destinations keep their text. */
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|\]\((?:[^()\s\\]|\\.)*\))/
/** \[ \] on lines of its own, with the indent or quote marks in front of it. */
const DISPLAY_LINES = /^([ \t>]*)(?<!\\)\\\[((?:[^\\]|\\[^\]])+?)\\\][ \t]*$/gm
const DISPLAY = /(?<!\\)\\\[((?:[^\\]|\\[^\]])+?)\\\]/g
const INLINE = /(?<!\\)\\\(((?:[^\\\n]|\\[^)\n])+?)\\\)/g

/**
 * Bots write LaTeX between \( \) and \[ \]. Markdown reads a backslash before a
 * bracket as an escape and drops it, so both become the $$ remark-math reads.
 * A \[ \] on lines of its own becomes a display block that keeps its line's
 * lead, so it stays inside its list item or quote.
 */
export function mathDelimiters(text: string) {
  return text
    .split(CODE)
    .map((part, index) =>
      index % 2
        ? part
        : part
            .replace(DISPLAY_LINES, (_, lead: string, tex: string) => {
              // Lines between the delimiters already carry their own lead.
              const top = /^[ \t]*\n/.test(tex)
                ? tex.replace(/^[ \t]+/, '')
                : `\n${lead}${tex.trimStart()}`

              const body = /\n[ \t>]*$/.test(top) ? top : `${top.trimEnd()}\n${lead}`

              return `${lead}$$${body}$$`
            })
            .replace(DISPLAY, (_, tex: string) => `$$${tex}$$`)
            .replace(INLINE, (_, tex: string) => `$$${tex}$$`)
    )
    .join('')
}
