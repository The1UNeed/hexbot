/**
 * The sentence the plugins table takes in its field: "give Research bots
 * Gmail", "take GitHub from Scout", "who has Notion", "what does Quill have".
 * Pure. Every word has to be placed: a name it does not know stops the
 * sentence, since a dropped word would change other bots than were meant.
 */

import { type AccessColumn, type AccessGroup, count, labelOf, labelsOf, listed } from './plugin-access'
import { ACCOUNT_NAMES } from './plugin-rows'
import type { Bot } from './types'

export type Sentence =
  /** "What does Quill have?" */
  | { bot: Bot; kind: 'about' }
  | {
      bots: Bot[]
      /** Who the sentence leaves out, in words. */
      but?: string
      columns: AccessColumn[]
      kind: 'change'
      on: boolean
      /** The bots as the sentence named them: "57 Ops bots and Scout". */
      who: string
    }
  /** "What do Sales bots have?" */
  | { kind: 'label'; label: string }
  /** What is missing or not understood, said so the user can finish the sentence. */
  | { kind: 'problem'; text: string }
  | { column: AccessColumn; has: boolean; kind: 'who' }

export interface SentenceWorld {
  bots: Bot[]
  groups: AccessGroup[]
}

const VERBS: Record<string, 'ask' | 'give' | 'take'> = {
  add: 'give',
  allow: 'give',
  give: 'give',
  grant: 'give',
  let: 'give',
  remove: 'take',
  revoke: 'take',
  stop: 'take',
  take: 'take',
  what: 'ask',
  which: 'ask',
  who: 'ask'
}

/** Words that join a sentence without naming anything. */
const FILLERS = new Set(
  `a able access account accounts all also an and are at away back be bot bots by can could did do does each every for
   from get gets give given has have having in into is it its of on or plugin plugins please reach
   reaches read reads see sees skill skills that the their them these they this those through to
   use uses using via with`.split(/\s+/)
)

const NEGATIONS = new Set(['cannot', 'cant', 'doesnt', 'dont', 'isnt', 'lack', 'lacks', 'no', 'not', 'without'])

const EVERYONE = ['every single bot', 'all of the bots', 'all the bots', 'every bot', 'all bots', 'everybody', 'everyone', 'every one']

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Finds `phrase` as whole words and blanks it, so no other name is read out of it. */
function lift(text: string, phrase: string): null | string {
  const found = new RegExp(`(^|[^a-z0-9])${escape(phrase)}(?=$|[^a-z0-9])`).exec(text)

  if (!found) {
    return null
  }

  const start = found.index + found[1]!.length

  return text.slice(0, start) + ' '.repeat(phrase.length) + text.slice(start + phrase.length)
}

type Entry =
  | { bot: Bot; phrase: string; type: 'bot' }
  | { columns: AccessColumn[]; phrase: string; type: 'column' }
  | { group: AccessGroup; phrase: string; type: 'account' }
  | { label: string; phrase: string; type: 'label' }
  | { phrase: string; type: 'everyone' }

/** Every name the sentence may use, the longest first so "google calendar" wins over "google". */
function vocabulary({ bots, groups }: SentenceWorld): Entry[] {
  const entries: Entry[] = EVERYONE.map(phrase => ({ phrase, type: 'everyone' }))

  for (const { label } of labelsOf(bots)) {
    for (const noun of ['bots', 'bot']) {
      entries.push({ label, phrase: `${label.toLowerCase()} ${noun}`, type: 'label' })
    }
  }

  for (const bot of bots) {
    for (const phrase of new Set([(bot.display_name || bot.name).toLowerCase(), bot.name.toLowerCase()])) {
      entries.push({ bot, phrase, type: 'bot' })
    }
  }

  const columns = new Map<string, AccessColumn[]>()

  for (const column of groups.flatMap(group => group.columns)) {
    const name = column.name.toLowerCase()

    // "Calendar" for Google Calendar, "release notes" for release-notes.
    const phrases = new Set([
      name,
      name.replace(/^(google|microsoft|outlook) (?=\S)/, ''),
      name.replace(/[-_]+/g, ' ')
    ])

    for (const phrase of phrases) {
      columns.set(phrase, [...(columns.get(phrase) ?? []), column])
    }
  }

  for (const [phrase, found] of columns) {
    entries.push({ columns: found, phrase, type: 'column' })
  }

  for (const group of groups) {
    if (!group.account) {
      continue
    }

    const provider = ACCOUNT_NAMES[group.account.provider].toLowerCase()

    for (const phrase of new Set([group.account.email?.toLowerCase() ?? provider, provider])) {
      entries.push({ group, phrase, type: 'account' })
    }
  }

  return entries.filter(entry => entry.phrase.trim()).sort((a, b) => b.phrase.length - a.phrase.length)
}

/** The names found in a stretch of text, and the words left that are not names. */
function read(text: string, entries: Entry[]): { found: Entry[]; rest: string[] } {
  const found: Entry[] = []
  let left = text

  for (const entry of entries) {
    for (let next = lift(left, entry.phrase); next !== null; next = lift(left, entry.phrase)) {
      left = next

      if (!found.includes(entry)) {
        found.push(entry)
      }
    }
  }

  return { found, rest: left.split(/[^a-z0-9@._'-]+/).filter(Boolean) }
}

const problem = (text: string): Sentence => ({ kind: 'problem', text })

/** The bots a stretch names, with how the sentence named them. */
function botsIn(found: Entry[], bots: Bot[]): { bots: Bot[]; text: string } {
  if (found.some(entry => entry.type === 'everyone')) {
    return { bots, text: 'every bot' }
  }

  const labels = found.flatMap(entry => (entry.type === 'label' ? [entry.label] : []))
  const named = found.flatMap(entry => (entry.type === 'bot' ? [entry.bot] : []))
  const inLabel = (bot: Bot) => labels.some(label => label.toLowerCase() === labelOf(bot).toLowerCase())
  const words: string[] = []

  for (const label of new Set(labels)) {
    words.push(count(bots.filter(bot => labelOf(bot).toLowerCase() === label.toLowerCase()).length, `${label} bot`))
  }

  for (const bot of new Set(named)) {
    if (!inLabel(bot)) {
      words.push(bot.display_name || bot.name)
    }
  }

  return { bots: bots.filter(bot => inLabel(bot) || named.includes(bot)), text: listed(words) }
}

/** What a sentence asks for, or null when the text is not a sentence and is a search. */
export function parseSentence(input: string, world: SentenceWorld): null | Sentence {
  const text = input
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[?!,;:]+/g, ' ')
    .replace(/\.+\s*$/, '')
    .trim()

  const verb = VERBS[text.split(/\s+/)[0] ?? '']

  if (!verb) {
    return null
  }

  const entries = vocabulary(world)
  const [mainText = '', ...after] = text.split(/\b(?:but not|but|except for|except|apart from|other than)\b/)
  const main = read(mainText, entries)
  const but = after.length ? read(after.join(' '), entries) : null

  // A word that names nothing would be dropped, and the change would reach other bots.
  const strangers = [...main.rest, ...(but?.rest ?? [])].filter(
    word => !FILLERS.has(word) && !NEGATIONS.has(word) && !(word in VERBS)
  )

  if (strangers.length) {
    const word = strangers[0]!
    const label = labelsOf(world.bots).find(each => each.label.toLowerCase() === word)

    return problem(
      label
        ? `Say "${label.label} bots" to mean the bots with that label.`
        : `"${word}" is not a bot, a label or a plugin here. Nothing is changed.`
    )
  }

  if (but && (but.found.some(entry => entry.type === 'column' || entry.type === 'account') || !but.found.length)) {
    return problem('After "but", name the bots or the label to leave out.')
  }

  // In the order the table shows them, whichever the sentence named first.
  const accounts = world.groups.filter(group =>
    main.found.some(entry => entry.type === 'account' && entry.group === group)
  )

  if (accounts.length > 1) {
    return problem(
      `One account at a time: ${listed(accounts.map(group => group.name))} need a sentence each.`
    )
  }

  const account = accounts[0]
  const order = world.groups.flatMap(group => group.columns)
  const columns: AccessColumn[] = []

  for (const entry of main.found) {
    if (entry.type !== 'column') {
      continue
    }

    const mine = account ? entry.columns.filter(column => column.group === account.id) : entry.columns
    const groupOf = (column: AccessColumn) => world.groups.find(group => group.id === column.group)!

    if (!mine.length) {
      return problem(`${entry.columns[0]!.name} is not connected in ${account!.name}.`)
    }

    if (new Set(mine.map(column => column.key)).size > 1) {
      const groups = [...new Set(mine.map(groupOf))]

      return problem(
        groups.length > 1 && groups.every(group => group.account)
          ? `Which account? Add ${groups.map(group => `"from ${group.name}"`).join(' or ')}.`
          : `Which one: ${mine.map(column => column.name).join(' or ')}?`
      )
    }

    if (!columns.includes(mine[0]!)) {
      columns.push(mine[0]!)
    }
  }

  // As the table orders them, whichever the sentence named first.
  columns.sort((a, b) => order.indexOf(a) - order.indexOf(b))

  if (account && !columns.some(column => column.group === account.id)) {
    return problem(`Name what to use from ${account.name}, such as ${account.columns[0]!.name}.`)
  }

  const named = botsIn(main.found, world.bots)

  if (verb === 'ask') {
    if (columns.length > 1) {
      return problem('Ask about one plugin at a time.')
    }

    if (columns.length) {
      return { column: columns[0]!, has: !main.rest.some(word => NEGATIONS.has(word)), kind: 'who' }
    }

    const labels = main.found.flatMap(entry => (entry.type === 'label' ? [entry.label] : []))

    if (named.bots.length === 1 && !labels.length) {
      return { bot: named.bots[0]!, kind: 'about' }
    }

    if (labels.length === 1 && named.bots.every(bot => labelOf(bot).toLowerCase() === labels[0]!.toLowerCase())) {
      return { kind: 'label', label: labels[0]! }
    }

    return problem('Ask who has a plugin, or what one bot has.')
  }

  if (!columns.length) {
    return problem('Name a plugin, such as Gmail or Notion.')
  }

  if (!named.bots.length) {
    return problem('Name the bots: a label such as Research bots, a bot, or every bot.')
  }

  const on = verb === 'give'
  const waiting = columns.find(column => column.waiting)

  if (on && waiting) {
    return problem(`${waiting.name} needs a new sign-in first.`)
  }

  const left = but ? botsIn(but.found, world.bots) : null

  return {
    bots: named.bots.filter(bot => !left?.bots.includes(bot)),
    but: left?.text,
    columns,
    kind: 'change',
    on,
    who: named.text
  }
}
