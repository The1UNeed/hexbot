// A paragraph in Word or PowerPoint is runs of text, each with its own look.
// The panel shows each run as a span and, when a paragraph is edited, puts
// the new text back into the same runs where it can, so the look stays.

import { NS, setRunText } from './package'

/** One run as the panel shows it. */
export interface RunView {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  /** `#rrggbb`. */
  color?: string
  /** Points. */
  size?: number
  /** A link's address. */
  href?: string
}

/**
 * Writes a paragraph's edited text back into its runs. When there are as
 * many texts as runs, each run takes its own; otherwise (runs merged while
 * typing) the first run takes all of it and the rest are emptied.
 */
export function writeRuns(runs: Element[], ns: typeof NS.a | typeof NS.w, texts: string[]) {
  if (!runs.length) {
    return
  }

  // A run left as it was keeps its tabs and breaks.
  const set = (run: Element, text: string) => {
    // A line break between PowerPoint runs is not a run, and stays.
    if (run.localName === 'br' && ns === NS.a) {
      return
    }

    if (runText(run, ns) !== text) {
      setRunText(run, ns, text)
    }
  }

  if (texts.length === runs.length) {
    runs.forEach((run, index) => set(run, texts[index]!))

    return
  }

  set(runs[0]!, texts.join(''))

  for (const run of runs.slice(1)) {
    set(run, '')
  }
}

/** A run's text as the panel shows it: tabs and breaks as characters. */
export function runText(run: Element, ns: string): string {
  let text = ''

  for (const node of Array.from(run.children)) {
    if (node.namespaceURI !== ns) {
      continue
    }

    if (node.localName === 't') {
      text += node.textContent ?? ''
    } else if (node.localName === 'tab') {
      text += '\t'
    } else if (node.localName === 'br' || node.localName === 'cr') {
      text += '\n'
    }
  }

  return text
}
