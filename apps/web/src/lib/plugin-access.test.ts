import { describe, expect, it } from 'vitest'

import {
  accessGroups,
  accessOf,
  changesOf,
  changeWho,
  cycle,
  foldRows,
  groupName,
  labelsOf,
  offersOf,
  pending,
  planOf,
  reversed,
  stage,
  usual
} from './plugin-access'
import { parseSentence } from './plugin-sentence'
import type { Bot, Plugin } from './types'

const bot = (name: string, title = '', primary = false) =>
  ({ display_name: name[0]!.toUpperCase() + name.slice(1), name, primary, title }) as Bot

const BOTS = [
  bot('hexbot', 'Primary bot', true),
  bot('scout', 'Sales'),
  bot('ada', 'sales'),
  bot('bea', 'Sales'),
  bot('quill', 'Research'),
  bot('juno', 'Research'),
  bot('solo')
]

const plugin = (id: string, name: string, bots: string[], more: Partial<Plugin> = {}): Plugin => ({
  bots,
  category: 'work',
  description: '',
  icon: id,
  id,
  kind: 'connector',
  name,
  ready: true,
  state: 'ready',
  state_text: '',
  ...more
})

const account = (email: string, provider: 'google' | 'microsoft', signed_in = true) =>
  ({ account: { email, provider, service: provider, signed_in } }) as Plugin['connector']

const PLUGINS: Plugin[] = [
  plugin('gmail', 'Gmail', ['hexbot', 'scout', 'ada', 'bea'], { connector: account('me@work.co', 'google') }),
  plugin('gcal', 'Google Calendar', ['hexbot'], { connector: account('me@work.co', 'google') }),
  plugin('outlook', 'Outlook', ['hexbot'], {
    connector: account('home@outlook.com', 'microsoft'),
    ready: false,
    state: 'error',
    waiting_bots: ['solo']
  }),
  plugin('ocal', 'Outlook Calendar', [], { connector: account('home@outlook.com', 'microsoft') }),
  plugin('notion', 'Notion', ['quill', 'juno']),
  plugin('slack', 'Slack', [], { state: 'not_set_up' }),
  plugin('github', 'github', ['scout'], { category: 'mcp' }),
  plugin('release-notes', 'release-notes', [], { category: 'other', kind: 'skill' }),
  plugin('off', 'off', [], { category: 'other', disabled_globally: true, kind: 'skill' })
]

const groups = accessGroups(PLUGINS)
const keys = groups.flatMap(group => group.columns.map(column => column.key))
const world = { bots: BOTS, groups }

describe('accessGroups', () => {
  it('puts each account’s connectors together, then the rest by kind', () => {
    expect(groups.map(group => [group.name, group.columns.map(column => column.name)])).toEqual([
      ['me@work.co', ['Gmail', 'Google Calendar']],
      ['home@outlook.com', ['Outlook', 'Outlook Calendar']],
      ['Connectors', ['Notion']],
      ['MCP servers', ['github']],
      ['Skills', ['release-notes']]
    ])
  })

  it('marks an account whose sign-in stopped working, and keeps its waiting bots as holders', () => {
    expect(groups[1]!.waiting).toBe(true)
    expect(groups[1]!.columns[0]!.waiting).toBe(true)
    expect(accessOf(PLUGINS, {}).has('solo', 'connector:outlook')).toBe(true)
  })
})

describe('offersOf', () => {
  it('sorts an account’s connectors into connected, waiting and still to connect', () => {
    const offers = offersOf([
      ...PLUGINS,
      plugin('gdrive', 'Google Drive', [], { connector: account('', 'google', false), ready: false, state: 'not_set_up' })
    ])

    const [google, microsoft] = offers.accounts

    expect(google!.connected.map(each => each.id)).toEqual(['gmail', 'gcal'])
    expect(google!.open.map(each => each.id)).toEqual(['gdrive'])
    expect(google!.emails).toEqual(['me@work.co'])
    expect(microsoft!.waiting.map(each => each.id)).toEqual(['outlook'])
    // A connector with a key that is not set up yet is offered; a server or a skill is added by hand.
    expect(offers.services.map(each => each.id)).toEqual(['slack'])
  })
})

describe('staging', () => {
  const access = accessOf(PLUGINS, {})

  it('keeps only grants that would change, and gives nothing that cannot be given', () => {
    const staged = stage({}, access, ['scout', 'quill'], ['connector:gmail', 'connector:outlook'], true)

    expect(staged).toEqual({ 'quill|connector:gmail': true })
    expect(stage(staged, access, ['quill'], ['connector:gmail'], false)).toEqual({})
  })

  it('a cell that began partly on goes all on, all off, and back', () => {
    const sales = ['scout', 'ada', 'bea']
    const first = cycle({}, access, sales, 'connector:github')
    const second = cycle(first, accessOf(PLUGINS, first), sales, 'connector:github')
    const third = cycle(second, accessOf(PLUGINS, second), sales, 'connector:github')

    expect(pending(first, access)).toHaveLength(2)
    expect(pending(second, access)).toEqual([{ bot: 'scout', key: 'connector:github', on: false }])
    expect(third).toEqual({})
  })

  it('a staged grant the daemon made so meanwhile is no longer a change', () => {
    const staged = { 'quill|connector:gmail': true }
    const given = PLUGINS.map(each => (each.id === 'gmail' ? { ...each, bots: [...each.bots, 'quill'] } : each))

    expect(pending(staged, accessOf(given, staged))).toEqual([])
  })
})

describe('rows and changes', () => {
  const access = accessOf(PLUGINS, {})

  it('folds bots by label, whatever its case, and by what they hold', () => {
    const rows = foldRows(BOTS, keys, access.has)

    expect(rows.map(row => groupName(row.bots))).toEqual(['Hexbot', 'Scout', '2 Sales bots', '2 Research bots', 'Solo'])
    expect(labelsOf(BOTS).map(each => [each.label, each.bots.length])).toEqual([
      ['Sales', 3],
      ['Research', 2]
    ])
  })

  it('folds bots whose labels are their own as if they had none', () => {
    const loners = [bot('ant', 'Writes the weekly report'), bot('bee', 'Books travel'), bot('cat')]

    expect(labelsOf(loners)).toEqual([])
    expect(foldRows(loners, keys, access.has).map(row => groupName(row.bots))).toEqual(['3 bots'])
  })

  it('says a whole label as one line and flags a first plugin from an account', () => {
    const flips = pending(stage({}, access, ['quill', 'juno', 'scout'], ['connector:gmail', 'connector:notion'], true), access)
    const lines = changesOf(flips, access, BOTS, groups)

    expect(lines.map(line => [changeWho(line), line.column.name, line.fresh])).toEqual([
      ['All 2 Research bots', 'Gmail', true],
      ['Scout', 'Notion', false]
    ])
  })

  it('plans one call a plugin and puts back exactly what it did', () => {
    const flips = [
      { bot: 'quill', key: 'connector:gmail', on: true },
      { bot: 'scout', key: 'connector:gmail', on: false }
    ]

    const [step] = planOf(flips, PLUGINS)

    expect(step!.bots.sort()).toEqual(['ada', 'bea', 'hexbot', 'quill'])
    expect(step!.keepWaiting).toBe(true)

    const after = PLUGINS.map(each => (each.id === 'gmail' ? { ...each, bots: step!.bots } : each))

    expect(planOf(reversed(flips), after)[0]!.bots.sort()).toEqual(['ada', 'bea', 'hexbot', 'scout'])
    // A sign-in that stopped working: the list holds every grant, so none is added back.
    expect(planOf([{ bot: 'solo', key: 'connector:outlook', on: false }], PLUGINS)[0]).toMatchObject({
      bots: ['hexbot'],
      keepWaiting: false
    })
  })

  it('knows what most of a label holds', () => {
    expect(usual('sales', BOTS, keys, access.has)).toEqual(['connector:gmail'])
  })
})

describe('parseSentence', () => {
  const said = (text: string) => parseSentence(text, world)

  it('leaves a search alone', () => {
    expect(said('quill')).toBeNull()
  })

  it('reads a change with its bots and plugins', () => {
    expect(said('Give Research bots Gmail and Google Calendar.')).toMatchObject({
      bots: [BOTS[4], BOTS[5]],
      columns: [{ name: 'Gmail' }, { name: 'Google Calendar' }],
      kind: 'change',
      on: true,
      who: '2 Research bots'
    })

    expect(said('take github away from Scout')).toMatchObject({ bots: [BOTS[1]], kind: 'change', on: false })
    expect(said('give Notion to every bot but Sales bots and Solo')).toMatchObject({
      bots: [BOTS[0], BOTS[4], BOTS[5]],
      but: '3 Sales bots and Solo'
    })
  })

  it('stops at any word it cannot place', () => {
    expect(said('give Sale bots Notion')).toEqual({
      kind: 'problem',
      text: '"sale" is not a bot, a label or a plugin here. Nothing is changed.'
    })
    expect(said('give Research bots Gmail and Notoin')).toMatchObject({ kind: 'problem' })
    expect(said('give Sales bots notion except Scout and Scuot')).toMatchObject({
      text: '"scuot" is not a bot, a label or a plugin here. Nothing is changed.'
    })
    expect(said('give research gmail')).toMatchObject({ text: 'Say "Research bots" to mean the bots with that label.' })
  })

  it('asks which calendar when two are meant, and takes the account named', () => {
    expect(said('take calendar from hexbot')).toMatchObject({
      text: 'Which account? Add "from me@work.co" or "from home@outlook.com".'
    })
    expect(said('take calendar from google from hexbot')).toMatchObject({ columns: [{ name: 'Google Calendar' }] })
    expect(said('give solo gmail from google and outlook calendar from microsoft')).toMatchObject({
      text: 'One account at a time: me@work.co and home@outlook.com need a sentence each.'
    })
  })

  it('gives nothing through a sign-in that stopped working, but takes it away', () => {
    expect(said('give Solo Outlook')).toMatchObject({ text: 'Outlook needs a new sign-in first.' })
    expect(said('take Outlook from Solo')).toMatchObject({ kind: 'change', on: false })
  })

  it('answers who has, who has not, and what a bot or a label has', () => {
    expect(said('who has Notion?')).toMatchObject({ column: { name: 'Notion' }, has: true, kind: 'who' })
    expect(said("who doesn't have notion")).toMatchObject({ has: false, kind: 'who' })
    expect(said('who has Gmail and Notion')).toMatchObject({ text: 'Ask about one plugin at a time.' })
    expect(said('What does Quill have?')).toEqual({ bot: BOTS[4], kind: 'about' })
    expect(said('what do Sales bots have')).toEqual({ kind: 'label', label: 'Sales' })
  })
})
