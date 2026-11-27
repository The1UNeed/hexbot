import { Ionicons } from '@expo/vector-icons'
import { useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import {
  type AccessColumn,
  type AccessGroup,
  accessGroups,
  accessOf,
  changesOf,
  changeWho,
  columnText,
  count,
  cycle,
  type Flip,
  foldRows,
  grantKey,
  groupName,
  labelOf,
  labelsOf,
  listed,
  offersOf,
  pending,
  planOf,
  reversed,
  sharedLabels,
  stage,
  type Staged,
  usual
} from '../../../web/src/lib/plugin-access'
import { DEFAULT_SERVER_ICON, DEFAULT_SKILL_ICON } from '../../../web/src/lib/plugin-icons'
import { ACCOUNT_NAMES, withWaiting } from '../../../web/src/lib/plugin-rows'
import { parseSentence } from '../../../web/src/lib/plugin-sentence'
import { botPhoto } from '../core/avatar'
import { setAccess, useAccess } from '../core/plugin-access'
import type { AccountProvider } from '../../../web/src/lib/types'
import type { Bot, Plugin } from '../core/types'
import {
  Banner,
  BotFace,
  Button,
  Field,
  Group,
  HIT,
  radius,
  Row,
  SwitchRow,
  Text,
  useTheme
} from '../ui'
import { PluginIcon } from '../ui/PluginIcon'

export interface PluginAccessProps {
  /** The daemon these bots and plugins belong to; changes that wait are kept for it alone. */
  daemon: string
  bots: Bot[]
  plugins: Plugin[]
  /** Gives a plugin to exactly these bots. */
  setBots: (plugin: Plugin, bots: string[]) => Promise<unknown>
  /** Reads the plugins again after a change. */
  reload: () => Promise<unknown>
  /** Opens a plugin's own page, where it is connected and tested. */
  onOpenPlugin: (plugin: Plugin) => void
  /** Opens a connector's sign-in, or its keys. */
  onConnect: (plugin: Plugin) => void
  /** Opens the page that adds an MCP server, or the one that writes a skill. */
  onAdd: (what: 'server' | 'skill') => void
}

/** Rows a group opens with. */
const STEP = 12
const NAME = 168
const CELL = 48
const ROW = 48
const HEAD = 84

type Mode =
  /** Choosing what to add. */
  | { kind: 'add' }
  /** One account's connectors, to connect or sign in to again. */
  | { kind: 'account'; provider: AccountProvider }
  | { kind: 'bot'; name: string }
  | { kind: 'review' }
  | { kind: 'table' }

/** One line of the grid: a row of bots, one bot inside an open row, or the rest of it. */
type Line =
  | { bots: Bot[]; id: string; kind: 'bot' | 'row' | 'sub'; name: string }
  | { id: string; kind: 'more'; left: number; row: string }

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Settings, Plugins as a table (Experimental), on a phone: one account's
 * plugins at a time across, the bots down, folded by label and by what they
 * hold. Changes wait until they are reviewed, as on the desktop; the grouping,
 * the staging and the sentence are the desktop's own code.
 */
export function PluginAccess({
  bots,
  daemon,
  onAdd,
  onConnect,
  onOpenPlugin,
  plugins,
  reload,
  setBots
}: PluginAccessProps) {
  const theme = useTheme()
  // Kept outside the page: opening a plugin and coming back loses no change that waits.
  const { last, pinned, staged } = useAccess(daemon)
  const setStaged = (next: (current: Staged) => Staged) =>
    setAccess(current => ({ staged: next(current.staged) }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>({ kind: 'table' })
  const [query, setQuery] = useState('')
  const [label, setLabel] = useState<string | null>(null)
  const [only, setOnly] = useState<{ has: boolean; key: string } | null>(null)
  const [solo, setSolo] = useState<string | null>(null)
  const [open, setOpen] = useState<string[]>([])
  const [full, setFull] = useState<string[]>([])
  // Review lines whose bots are all listed.
  const [named, setNamed] = useState<string[]>([])

  // The primary bot first, as everywhere else.
  const roster = useMemo(
    () =>
      [...bots]
        .sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)))
        .map(bot => ({ ...bot, display_name: bot.display_name || bot.name })),
    [bots]
  )
  const groups = useMemo(() => accessGroups(plugins), [plugins])
  const columns = useMemo(() => groups.flatMap(group => group.columns), [groups])
  const access = useMemo(() => accessOf(plugins, staged), [plugins, staged])
  const flips = useMemo(() => pending(staged, access), [access, staged])
  const labels = useMemo(() => labelsOf(roster), [roster])
  const shared = useMemo(() => sharedLabels(roster), [roster])
  const keys = useMemo(() => columns.map(column => column.key), [columns])
  const basis = useMemo(() => accessOf(pinned ?? plugins, {}), [pinned, plugins])
  const sentence = useMemo(() => parseSentence(query, { bots: roster, groups }), [groups, query, roster])
  const needle = sentence ? '' : query.trim().toLowerCase()
  const shown = useMemo(
    () =>
      roster.filter(
        bot =>
          (label === null || labelOf(bot).toLowerCase() === label.toLowerCase()) &&
          (!needle || `${bot.display_name} ${bot.name} ${labelOf(bot)}`.toLowerCase().includes(needle)) &&
          (!only || access.value(bot.name, only.key) === only.has)
      ),
    [access, label, needle, only, roster]
  )
  const rows = useMemo(() => foldRows(shown, keys, basis.has, shared), [basis, keys, shared, shown])
  const stale =
    !!pinned &&
    foldRows(shown, keys, accessOf(plugins, {}).has, shared)
      .map(row => row.id)
      .join('|') !== rows.map(row => row.id).join('|')

  const group = groups.find(each => each.id === solo) ?? groups[0]
  const colorOf = (id: string) => {
    const at = groups.filter(each => each.account).findIndex(each => each.id === id)
    return at < 0 ? theme.text : theme.chart[at % theme.chart.length]!
  }
  const textOf = (column: AccessColumn) => columnText(column, groups)
  const changes = changesOf(flips, access, roster, groups)
  const changed = new Set(flips.map(flip => flip.bot)).size
  const summary = `${count(changes.length, 'change')} for ${count(changed, 'bot')}`

  const give = (names: string[], wanted: string[], on: boolean) => {
    setError(null)
    setStaged(current => stage(current, access, names, wanted, on))
  }
  const press = (names: string[], key: string) => {
    setError(null)
    setStaged(current => cycle(current, access, names, key))
  }
  const unstage = (names: string[], key: string) =>
    setStaged(current => {
      const next = { ...current }
      for (const name of names) delete next[grantKey(name, key)]
      return next
    })

  /** Sends `sent` plugin by plugin. What a plugin refuses is returned with the reason. */
  const send = async (sent: Flip[]) => {
    const done: Flip[] = []
    const failed: string[] = []
    for (const step of planOf(sent, plugins)) {
      try {
        await setBots(step.plugin, step.keepWaiting ? withWaiting(step.plugin, step.bots) : step.bots)
        done.push(...step.flips)
      } catch (cause) {
        failed.push(`${step.plugin.name}: ${errorText(cause)}`)
      }
    }
    await reload()
    return { done, failed }
  }
  const apply = async () => {
    if (!flips.length || busy) return
    const before = plugins
    setBusy(true)
    setError(null)
    const { done, failed } = await send(flips)
    // What a plugin refused stays staged, so nothing asked for is lost.
    const left = flips.filter(flip => !done.includes(flip))
    setAccess(current => ({
      last: done.length ? { flips: done, text: failed.length ? 'some of the changes' : summary } : null,
      pinned: current.pinned ?? before,
      staged: Object.fromEntries(left.map(flip => [grantKey(flip.bot, flip.key), flip.on]))
    }))
    setError(failed.length ? failed.join(' ') : null)
    setBusy(false)
    setMode({ kind: 'table' })
  }
  const undo = async () => {
    if (!last || busy) return
    setBusy(true)
    setError(null)
    const { failed } = await send(reversed(last.flips))
    setAccess(() => ({ last: null }))
    setError(failed.length ? failed.join(' ') : null)
    setBusy(false)
  }

  const box = (names: string[], column: AccessColumn, name: string) => {
    const held = names.filter(bot => access.value(bot, column.key)).length
    const state = held === names.length ? 'on' : held ? 'some' : 'off'
    const stuck = !held && names.every(bot => !access.canGive(bot, column.key))
    const staging = names.some(bot => access.changed(bot, column.key))
    const color = colorOf(column.group)
    const soft = state === 'some' || (column.waiting && state === 'on')
    const said = stuck
      ? column.waiting
        ? 'needs a new sign-in first'
        : 'not set up for this bot yet'
      : column.waiting
        ? 'waiting for a new sign-in'
        : state === 'some'
          ? `${held} of ${names.length} ${held === 1 ? 'has' : 'have'} it`
          : null
    return (
      <Pressable
        accessibilityLabel={[`${textOf(column)} for ${name}`, said, staging ? 'not applied yet' : null]
          .filter(Boolean)
          .join(', ')}
        accessibilityRole="checkbox"
        accessibilityState={{
          checked: state === 'on' ? true : state === 'some' ? 'mixed' : false,
          disabled: stuck || busy
        }}
        disabled={stuck || busy}
        key={column.key}
        onPress={() => press(names, column.key)}
        style={({ pressed }) => [
          styles.cell,
          { backgroundColor: pressed ? theme.pressed : 'transparent', opacity: stuck ? 0.45 : 1 }
        ]}
        testID={`access-${name}-${column.key}`}
      >
        <View
          style={[
            styles.box,
            state === 'off'
              ? { borderColor: theme.muted, borderWidth: 1.5 }
              : soft
                ? { backgroundColor: `${color}33`, borderColor: color, borderWidth: 1.5 }
                : { backgroundColor: color }
          ]}
        >
          {column.waiting && state !== 'off' ? (
            <Ionicons color={theme.text} name="warning-outline" size={13} />
          ) : state === 'on' ? (
            <Ionicons color={theme.background} name="checkmark" size={16} />
          ) : state === 'some' ? (
            <Ionicons color={theme.text} name="remove" size={15} />
          ) : null}
          {staging ? (
            // A dot at the corner marks what is staged; shape, not colour alone.
            <View
              style={[styles.dot, { backgroundColor: theme.text, borderColor: theme.surface }]}
            />
          ) : null}
        </View>
      </Pressable>
    )
  }

  const pill = (text: string, on: boolean, onPress: () => void, testID: string, extra?: React.ReactNode) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      key={testID}
      onPress={onPress}
      style={[styles.pill, { backgroundColor: on ? theme.text : theme.fill }]}
      testID={testID}
    >
      {extra}
      <Text numberOfLines={1} style={{ color: on ? theme.background : theme.text }} variant="footnote">
        {text}
      </Text>
    </Pressable>
  )

  // Adding a plugin: an account first, then the services with a key, then your own.
  if (mode.kind === 'add' || mode.kind === 'account') {
    const offers = offersOf(plugins)
    const offer = mode.kind === 'account' ? offers.accounts.find(each => each.provider === mode.provider) : undefined

    const open = (plugin: Plugin, subtitle: string, tone?: 'danger') => (
      <Row
        chevron
        key={`${plugin.kind}:${plugin.id}`}
        leading={<PluginIcon icon={plugin.icon} />}
        // What is connected opens its own page; the rest goes straight to connecting.
        // Discord is connected bot by bot, on its page.
        onPress={() =>
          plugin.connector && plugin.id !== 'discord' && (plugin.state === 'not_set_up' || !plugin.ready)
            ? onConnect(plugin)
            : onOpenPlugin(plugin)
        }
        subtitle={subtitle}
        subtitleTone={tone}
        testID={`access-add-${plugin.kind}:${plugin.id}`}
        title={plugin.name}
      />
    )

    if (offer) {
      const name = ACCOUNT_NAMES[offer.provider]
      const held = [...offer.connected, ...offer.waiting]

      return (
        <>
          <Text tone="muted">
            {offer.open.length
              ? `Open one to sign in. The same sign-in can connect the others too, and ${name} asks you to allow each one.`
              : `Everything ${name} offers is connected.`}
          </Text>
          {offer.open.length ? (
            <Group title="To connect">{offer.open.map(plugin => open(plugin, plugin.description))}</Group>
          ) : null}
          {held.length ? (
            <Group
              footer="Each connector uses one account. Sign in with another address for the ones still to connect, and they sit in the table under that address."
              title="Connected"
            >
              {held.map(plugin =>
                offer.waiting.includes(plugin)
                  ? open(plugin, 'Needs a new sign-in', 'danger')
                  : open(plugin, plugin.connector?.account?.email ?? 'Connected')
              )}
            </Group>
          ) : null}
          <Button label="Back" onPress={() => setMode({ kind: 'add' })} testID="access-account-back" variant="plain" />
        </>
      )
    }

    return (
      <>
        <Text tone="muted">
          Choose what to add. Once it is connected it is a column in the table, and you tick the bots that
          get it.
        </Text>
        <Group title="Accounts">
          {offers.accounts.map(each => {
            const all = [...each.connected, ...each.waiting, ...each.open]
            const held = each.connected.length + each.waiting.length

            return (
              <Row
                chevron
                key={each.provider}
                leading={<PluginIcon icon={all[0]!.icon} />}
                onPress={() => setMode({ kind: 'account', provider: each.provider })}
                subtitle={
                  each.waiting.length
                    ? `${listed(each.waiting.map(plugin => plugin.name))} ${each.waiting.length === 1 ? 'needs' : 'need'} a new sign-in`
                    : held
                      ? `${each.emails.join(', ') || 'Signed in'} · ${held} of ${all.length} connected`
                      : listed(all.slice(0, 3).map(plugin => plugin.name))
                }
                subtitleTone={each.waiting.length ? 'danger' : undefined}
                testID={`access-add-account-${each.provider}`}
                title={`${ACCOUNT_NAMES[each.provider]} account`}
              />
            )
          })}
        </Group>
        {offers.services.length ? (
          <Group title="Services">{offers.services.map(plugin => open(plugin, plugin.description))}</Group>
        ) : null}
        <Group title="Your own">
          <Row
            chevron
            leading={<PluginIcon icon={DEFAULT_SERVER_ICON} />}
            onPress={() => onAdd('server')}
            subtitle="A command or a URL"
            testID="access-add-server"
            title="MCP server"
          />
          <Row
            chevron
            leading={<PluginIcon icon={DEFAULT_SKILL_ICON} />}
            onPress={() => onAdd('skill')}
            subtitle="Instructions bots follow for a particular job"
            testID="access-add-skill"
            title="Skill"
          />
        </Group>
        {offers.off.length ? (
          <Group footer="Open one to turn it on again." title="Off for every bot">
            {offers.off.map(plugin => open(plugin, plugin.state_text))}
          </Group>
        ) : null}
        <Button label="Back to the table" onPress={() => setMode({ kind: 'table' })} testID="access-add-back" variant="plain" />
      </>
    )
  }

  if (!columns.length) {
    return (
      <>
        <Text tone="muted" testID="access-empty">
          No plugin is set up yet. Sign in to an account, set up a service, or add an MCP server or a
          skill. Each one becomes a column here.
        </Text>
        <Button label="Add plugin" onPress={() => setMode({ kind: 'add' })} testID="access-add" variant="primary" />
      </>
    )
  }

  if (mode.kind === 'review') {
    return (
      <>
        <Text variant="headline">Review {summary}</Text>
        <Text tone="muted" variant="callout">
          Nothing has changed yet. Take out any line you did not mean.
        </Text>
        {error ? <Banner message={error} testID="access-error" tone="danger" /> : null}
        <View style={[styles.changes, { backgroundColor: theme.surface }]}>
          {changes.map((change, at) => {
            const one = change.bots.length === 1
            const who = changeWho(change)
            const what = `${change.on ? (one ? 'gets' : 'get') : one ? 'loses' : 'lose'} ${textOf(change.column)}`
            const from = groups.find(each => each.id === change.column.group)
            const id = `${change.on}:${change.column.key}:${change.bots[0]!.name}`
            const all = named.includes(id)
            const names = change.bots.map(bot => bot.display_name)
            return (
              <View
                key={id}
                style={[styles.change, at > 0 && { borderTopColor: theme.hairline, borderTopWidth: StyleSheet.hairlineWidth }]}
                testID={`access-change-${change.column.key}-${change.bots[0]!.name}`}
              >
                <PluginIcon icon={change.column.plugin.icon} />
                <View style={styles.grow}>
                  {/* The whole sentence, never cut: it is what is about to happen. */}
                  <Text variant="callout">
                    {who} {what}
                  </Text>
                  {change.fresh && from ? (
                    <Text style={{ color: theme.warning }} variant="footnote">
                      {one ? 'Its' : 'Their'} first plugin from {from.name}
                    </Text>
                  ) : null}
                  {one ? null : (
                    <Pressable
                      accessibilityHint={all ? undefined : 'Lists every bot'}
                      accessibilityRole="button"
                      disabled={all || names.length <= 4}
                      onPress={() => setNamed([...named, id])}
                      testID={`access-names-${change.column.key}-${change.bots[0]!.name}`}
                    >
                      <Text tone="muted" variant="footnote">
                        {all || names.length <= 4
                          ? names.join(', ')
                          : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more. Show all`}
                      </Text>
                    </Pressable>
                  )}
                </View>
                <Button
                  accessibilityLabel={`Take out of the changes: ${who} ${what}`}
                  disabled={busy}
                  label="Take out"
                  onPress={() =>
                    unstage(
                      change.bots.map(bot => bot.name),
                      change.column.key
                    )
                  }
                  size="small"
                  testID={`access-take-out-${change.column.key}-${change.bots[0]!.name}`}
                  variant="plain"
                />
              </View>
            )
          })}
        </View>
        <Text tone="muted" variant="footnote">
          Chats pick the change up at their next message. Undo stays until the next change is applied.
        </Text>
        <Button
          busy={busy}
          busyLabel="Applying"
          disabled={!flips.length}
          label={`Apply ${count(changes.length, 'change')}`}
          onPress={() => void apply()}
          testID="access-apply"
          variant="primary"
          wide
        />
        <Button
          disabled={busy}
          label="Keep editing"
          onPress={() => setMode({ kind: 'table' })}
          testID="access-keep-editing"
          variant="plain"
          wide
        />
      </>
    )
  }

  if (mode.kind === 'bot') {
    const bot = roster.find(each => each.name === mode.name)
    if (bot) {
      const mine = labelOf(bot)
      const mates = labels.find(each => each.label.toLowerCase() === mine.toLowerCase())?.bots ?? []
      const others = mates.length - 1
      const usually = others > 0 ? usual(mine, roster, keys, access.has) : []
      const extra = others > 0 ? columns.filter(c => access.value(bot.name, c.key) && !usually.includes(c.key)) : []
      const missing = columns.filter(c => usually.includes(c.key) && !access.value(bot.name, c.key))
      const held = columns.filter(c => access.value(bot.name, c.key)).length
      const forBot = flips.filter(flip => flip.bot === bot.name).length
      return (
        <>
          <View style={styles.identity}>
            <BotFace face={bot.face} imageUri={botPhoto(bot)} name={bot.display_name} size={44} />
            <View style={styles.grow}>
              <Text variant="headline">{bot.display_name}</Text>
              <Text tone="muted" variant="footnote">
                {bot.primary ? 'Primary bot' : mine || 'No label'}, {count(held, 'plugin')}
              </Text>
            </View>
          </View>
          {bot.primary ? (
            <Text tone="muted" variant="callout">
              The primary bot looks after the others, so it usually has every plugin.
            </Text>
          ) : others <= 0 ? null : extra.length || missing.length ? (
            <Group title={`Differs from the other ${count(others, `${mine} bot`)}`}>
              {[...extra.map(column => ({ column, on: true })), ...missing.map(column => ({ column, on: false }))].map(
                each => {
                  const staging = access.changed(bot.name, each.column.key)
                  return (
                    <Row
                      key={each.column.key}
                      leading={<PluginIcon icon={each.column.plugin.icon} />}
                      testID={`access-differs-${each.column.key}`}
                      title={`${
                        each.on
                          ? staging
                            ? 'Will also have'
                            : 'Also has'
                          : staging
                            ? 'Will no longer have'
                            : 'Has no'
                      } ${textOf(each.column)}`}
                      trailing={
                        <Button
                          label={each.on ? 'Take away' : 'Give'}
                          onPress={() => give([bot.name], [each.column.key], !each.on)}
                          size="small"
                          testID={`access-differs-fix-${each.column.key}`}
                          variant="secondary"
                        />
                      }
                    />
                  )
                }
              )}
            </Group>
          ) : (
            <Text tone="muted" variant="callout">
              Has the same plugins as the other {count(others, `${mine} bot`)}.
            </Text>
          )}
          {groups.map(each => (
            <Group
              footer={each.waiting ? 'Sign in again to this account before giving it to more bots.' : undefined}
              key={each.id}
              title={each.account ? `${each.name} · ${ACCOUNT_NAMES[each.account.provider]}` : each.name}
            >
              {each.columns.map(column => {
                const on = access.value(bot.name, column.key)
                const staging = access.changed(bot.name, column.key)
                const stuck = !on && !access.canGive(bot.name, column.key)
                return (
                  <SwitchRow
                    disabled={stuck || busy}
                    key={column.key}
                    leading={<PluginIcon icon={column.plugin.icon} />}
                    onValueChange={next => give([bot.name], [column.key], next)}
                    subtitle={
                      staging
                        ? on
                          ? 'Will be given'
                          : 'Will be taken away'
                        : column.waiting && on
                          ? 'Waiting for a new sign-in'
                          : stuck
                            ? column.waiting
                              ? 'Needs a new sign-in first'
                              : 'Not set up for this bot yet'
                            : null
                    }
                    testID={`access-switch-${column.key}`}
                    title={column.name}
                    value={on}
                  />
                )
              })}
            </Group>
          ))}
          <Text tone="muted" variant="footnote">
            {flips.length
              ? `${forBot ? `${count(forBot, 'change')} for ${bot.display_name}` : `${count(flips.length, 'change')} for other bots`}${
                  forBot && forBot < flips.length ? ` and ${flips.length - forBot} for other bots` : ''
                }, not applied yet.`
              : 'Nothing changes until you review.'}
          </Text>
          {flips.length ? (
            <Button
              label="Review"
              onPress={() => setMode({ kind: 'review' })}
              testID="access-bot-review"
              variant="primary"
              wide
            />
          ) : null}
          <Button
            label="Back to the table"
            onPress={() => setMode({ kind: 'table' })}
            testID="access-bot-back"
            variant={flips.length ? 'plain' : 'secondary'}
            wide
          />
        </>
      )
    }
  }

  /** What the sentence in the field would do, said back before anything is staged. */
  const answer = (() => {
    if (!sentence) return null
    switch (sentence.kind) {
      case 'problem':
        return { problem: sentence.text }
      case 'about':
        return {
          act: () => {
            setMode({ kind: 'bot', name: sentence.bot.name })
            setQuery('')
          },
          button: `Open ${sentence.bot.display_name || sentence.bot.name}`,
          text: 'Its page lists everything it has.'
        }
      case 'label':
        return {
          act: () => {
            setLabel(sentence.label)
            setQuery('')
          },
          button: `Show ${sentence.label} bots`,
          text: `The table can show only the ${sentence.label} bots.`
        }
      case 'who': {
        const holders = roster.filter(bot => access.value(bot.name, sentence.column.key) === sentence.has)
        return {
          act: () => {
            setOnly({ has: sentence.has, key: sentence.column.key })
            setLabel(null)
            setQuery('')
          },
          button: 'Show only them',
          text: `${count(holders.length, 'bot')} ${
            holders.length === 1 ? (sentence.has ? 'has' : 'does not have') : sentence.has ? 'have' : 'do not have'
          } ${textOf(sentence.column)}.${flips.length ? ' This counts the changes that are not applied yet.' : ''}`
        }
      }
      default: {
        const { on } = sentence
        const wanted = sentence.columns.map(column => column.key)
        const changing = sentence.bots.filter(bot =>
          wanted.some(key => access.value(bot.name, key) !== on && (!on || access.canGive(bot.name, key)))
        )
        const one = sentence.bots.length === 1
        const who = sentence.who[0]!.toUpperCase() + sentence.who.slice(1)
        const text = `${who}${sentence.but ? `, but not ${sentence.but},` : ''} ${
          on ? (one ? 'gets' : 'get') : one ? 'loses' : 'lose'
        } ${listed(sentence.columns.map(textOf))}.`
        if (!changing.length) return { problem: `${text} Nothing to change.` }
        return {
          act: () => {
            give(
              changing.map(bot => bot.name),
              wanted,
              on
            )
            setQuery('')
          },
          button: 'Add to changes',
          text: `${text} ${count(changing.length, 'bot')} ${changing.length === 1 ? 'changes' : 'change'}.`
        }
      }
    }
  })()

  const lines: Line[] = rows.flatMap((row): Line[] => {
    if (row.bots.length === 1) {
      const bot = row.bots[0]!
      return [{ bots: row.bots, id: row.id, kind: 'bot', name: bot.display_name }]
    }
    const head: Line = { bots: row.bots, id: row.id, kind: 'row', name: groupName(row.bots) }
    if (!open.includes(row.id)) return [head]
    const inside = full.includes(row.id) ? row.bots : row.bots.slice(0, STEP)
    return [
      head,
      ...inside.map((bot): Line => ({ bots: [bot], id: `bot:${bot.name}`, kind: 'sub', name: bot.display_name })),
      ...(row.bots.length > inside.length
        ? [{ id: `more:${row.id}`, kind: 'more' as const, left: row.bots.length - inside.length, row: row.id }]
        : [])
    ]
  })

  return (
    <>
      <Field
        autoCapitalize="none"
        autoCorrect={false}
        hideLabel
        hint="Type a name to find a bot, or a change such as: give every bot Web search."
        label="Find a bot, or type a change"
        onChangeText={setQuery}
        onSubmitEditing={() => answer?.act?.()}
        placeholder="Find a bot, or type a change"
        returnKeyType="done"
        testID="access-field"
        value={query}
      />
      {answer ? (
        <View accessibilityLiveRegion="polite" style={[styles.card, { backgroundColor: theme.fill }]}>
          <Text tone={answer.problem ? 'danger' : 'text'} variant="callout" testID="access-answer">
            {answer.problem ?? answer.text}
          </Text>
          {answer.act ? (
            <Button label={answer.button!} onPress={answer.act} size="small" testID="access-answer-act" variant="primary" />
          ) : null}
        </View>
      ) : null}
      {error ? <Banner message={error} testID="access-error" tone="danger" /> : null}
      {flips.length || last ? (
        <View accessibilityLiveRegion="polite" style={[styles.card, { backgroundColor: theme.surface }]} testID="access-bar">
          <Text variant="callout">
            {flips.length
              ? `${summary}, not applied yet.`
              : `Applied ${last!.text}. Chats pick it up at the next message.`}
          </Text>
          <View style={styles.actions}>
            {flips.length ? (
              <>
                <Button
                  disabled={busy}
                  label="Discard"
                  onPress={() => setStaged(() => ({}))}
                  size="small"
                  testID="access-discard"
                  variant="plain"
                />
                <Button
                  label={`Review ${count(changes.length, 'change')}`}
                  onPress={() => setMode({ kind: 'review' })}
                  size="small"
                  testID="access-review"
                  variant="primary"
                />
              </>
            ) : (
              <Button
                busy={busy}
                busyLabel="Undoing"
                label="Undo"
                onPress={() => void undo()}
                size="small"
                testID="access-undo"
                variant="secondary"
              />
            )}
          </View>
        </View>
      ) : null}
      <ScrollView contentContainerStyle={styles.pills} horizontal showsHorizontalScrollIndicator={false}>
        {pill('All bots', label === null && !only, () => (setLabel(null), setOnly(null)), 'access-label-all')}
        {labels.map(each =>
          pill(
            `${each.label} ${each.bots.length}`,
            label?.toLowerCase() === each.label.toLowerCase(),
            () => setLabel(each.label),
            `access-label-${each.label}`
          )
        )}
        {only
          ? pill(
              `${only.has ? 'Has' : 'Has no'} ${columns.find(column => column.key === only.key)?.name ?? ''} ×`,
              true,
              () => setOnly(null),
              'access-only'
            )
          : null}
      </ScrollView>
      <ScrollView contentContainerStyle={styles.pills} horizontal showsHorizontalScrollIndicator={false}>
        {groups.map((each: AccessGroup) =>
          pill(
            each.name,
            each.id === group?.id,
            () => setSolo(each.id),
            `access-group-${each.id}`,
            each.account ? (
              <View style={[styles.swatch, { backgroundColor: colorOf(each.id) }]} />
            ) : each.waiting ? (
              <Ionicons color={theme.warning} name="warning-outline" size={13} />
            ) : null
          )
        )}
        {pill(
          'Add plugin',
          false,
          () => setMode({ kind: 'add' }),
          'access-add',
          <Ionicons color={theme.text} name="add" size={15} />
        )}
      </ScrollView>
      {group?.waiting ? (
        <View style={[styles.card, { backgroundColor: theme.fill }]}>
          <Text variant="footnote">
            {group.name} needs a new sign-in. Bots keep what they were given; nothing new is given until then.
          </Text>
          <Button
            label="Sign in again"
            onPress={() => onConnect(group.columns.find(column => column.waiting)!.plugin)}
            size="small"
            testID="access-sign-in-again"
            variant="secondary"
          />
        </View>
      ) : null}
      <View style={[styles.grid, { backgroundColor: theme.surface }]} testID="access-grid">
        <View style={{ width: NAME }}>
          <View style={[styles.corner, { borderBottomColor: theme.hairline }]}>
            <Text tone="muted" variant="caption">
              {count(shown.length, 'bot')} in {count(rows.length, 'row')}
            </Text>
          </View>
          {lines.map(line =>
            line.kind === 'more' ? (
              <Pressable
                accessibilityRole="button"
                key={line.id}
                onPress={() => setFull([...full, line.row])}
                style={[styles.name, styles.sub]}
                testID={`access-more-${line.row}`}
              >
                <Text tone="accent" variant="footnote">
                  Show {line.left} more
                </Text>
              </Pressable>
            ) : (
              <Pressable
                accessibilityHint={line.kind === 'row' ? 'Shows or hides its bots' : 'Opens its plugins'}
                accessibilityLabel={line.name}
                accessibilityRole="button"
                accessibilityState={line.kind === 'row' ? { expanded: open.includes(line.id) } : undefined}
                key={line.id}
                onPress={() =>
                  line.kind === 'row'
                    ? setOpen(open.includes(line.id) ? open.filter(id => id !== line.id) : [...open, line.id])
                    : setMode({ kind: 'bot', name: line.bots[0]!.name })
                }
                style={({ pressed }) => [
                  styles.name,
                  line.kind === 'sub' && styles.sub,
                  { backgroundColor: pressed ? theme.pressed : 'transparent', borderTopColor: theme.hairline }
                ]}
                testID={`access-row-${line.id}`}
              >
                {line.kind === 'row' ? (
                  <Ionicons
                    color={theme.muted}
                    name={open.includes(line.id) ? 'chevron-down' : 'chevron-forward'}
                    size={14}
                  />
                ) : (
                  <BotFace
                    face={line.bots[0]!.face}
                    imageUri={botPhoto(line.bots[0])}
                    name={line.name}
                    size={22}
                  />
                )}
                <Text numberOfLines={1} style={styles.grow} variant={line.kind === 'sub' ? 'footnote' : 'callout'}>
                  {line.name}
                </Text>
              </Pressable>
            )
          )}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator>
          <View>
            <View style={[styles.heads, { borderBottomColor: theme.hairline }]}>
              {(group?.columns ?? []).map(column => (
                <Pressable
                  accessibilityHint="Opens the plugin"
                  accessibilityLabel={`${textOf(column)}, ${count(
                    shown.filter(bot => access.value(bot.name, column.key)).length,
                    'bot'
                  )} of ${shown.length} shown`}
                  accessibilityRole="button"
                  key={column.key}
                  onPress={() => onOpenPlugin(column.plugin)}
                  style={styles.head}
                  testID={`access-head-${column.key}`}
                >
                  <PluginIcon icon={column.plugin.icon} size={24} />
                  <Text align="center" numberOfLines={2} style={styles.headText} tone="muted">
                    {column.name}
                  </Text>
                  <Text align="center" variant="caption">
                    {shown.filter(bot => access.value(bot.name, column.key)).length}
                  </Text>
                </Pressable>
              ))}
            </View>
            {lines.map(line => (
              <View key={line.id} style={[styles.cells, { borderTopColor: theme.hairline }]}>
                {line.kind === 'more'
                  ? null
                  : (group?.columns ?? []).map(column =>
                      box(
                        line.bots.map(bot => bot.name),
                        column,
                        line.name
                      )
                    )}
              </View>
            ))}
          </View>
        </ScrollView>
      </View>
      {rows.length ? null : (
        <Text tone="muted" variant="footnote">
          No bot matches. Clear the search or the filters.
        </Text>
      )}
      {stale ? (
        <View style={styles.actions}>
          <Text style={styles.grow} tone="muted" variant="footnote">
            Rows are grouped as they were before your last change, so none moved.
          </Text>
          <Button label="Group again" onPress={() => setAccess(() => ({ pinned: null }))} size="small" testID="access-regroup" variant="plain" />
        </View>
      ) : null}
      <Text tone="muted" variant="footnote">
        A tick is a grant, a dash means only some of the row have it. Tap a box to change it, a bot to
        see all it has, and a plugin to open it.
      </Text>
    </>
  )
}

const styles = StyleSheet.create({
  actions: { alignItems: 'center', flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  box: { alignItems: 'center', borderRadius: 7, height: 24, justifyContent: 'center', width: 24 },
  card: { borderRadius: radius.card, gap: 10, paddingHorizontal: 16, paddingVertical: 12 },
  change: { alignItems: 'flex-start', flexDirection: 'row', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  changes: { borderRadius: radius.card, overflow: 'hidden' },
  cell: { alignItems: 'center', height: ROW, justifyContent: 'center', minWidth: HIT, width: CELL },
  cells: { borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', height: ROW },
  corner: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    height: HEAD,
    justifyContent: 'flex-end',
    paddingBottom: 8,
    paddingHorizontal: 12
  },
  dot: { borderRadius: 5, borderWidth: 2, height: 10, position: 'absolute', right: -5, top: -5, width: 10 },
  grid: { borderRadius: radius.card, flexDirection: 'row', overflow: 'hidden' },
  grow: { flex: 1 },
  head: { alignItems: 'center', gap: 2, height: HEAD, justifyContent: 'flex-end', paddingBottom: 6, width: CELL },
  headText: { fontSize: 10, lineHeight: 12 },
  heads: { borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', height: HEAD },
  identity: { alignItems: 'center', flexDirection: 'row', gap: 12 },
  name: {
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 8,
    height: ROW,
    paddingHorizontal: 12
  },
  pill: {
    alignItems: 'center',
    borderRadius: radius.pill,
    flexDirection: 'row',
    gap: 6,
    height: 32,
    maxWidth: 220,
    paddingHorizontal: 12
  },
  pills: { gap: 6, paddingVertical: 2 },
  sub: { paddingLeft: 30 },
  swatch: { borderRadius: 4, height: 8, width: 8 }
})
