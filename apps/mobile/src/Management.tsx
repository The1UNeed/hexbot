import { useEffect, useRef, useState } from 'react'
import { Linking, StyleSheet, View } from 'react-native'
import {
  Banner,
  BotFace,
  Button,
  ChoiceRow,
  confirm,
  Field,
  Form,
  Group,
  Layer,
  radius,
  Row,
  Segmented,
  SwitchRow,
  Text,
  useTheme
} from './ui'
import { Licenses } from './Licenses'
import { ModelPill } from './screens/ModelMenu'
import {
  type Bot,
  type Connector,
  type Device,
  type PasswordLogin,
  type Plugin,
  type PluginsList,
  type Room,
  type Rpc,
  type Section,
  type SkillRequirement
} from './core/types'
import { botPhoto } from './core/avatar'
import { scheduleChange } from './core/jobs'
import { requirementText } from './core/skills'
import { pluginRows } from '../../web/src/lib/plugin-rows'
import { isOpenRoom } from './core/routes'
import { pickFile } from './core/pickFile'
import type { useMobile } from './core/useMobile'
export type Panel = {
  kind:
    | 'about'
    | 'activity'
    | 'bot'
    | 'bot-create'
    | 'connect'
    | 'connector'
    | 'connectors'
    | 'devices'
    | 'dreams'
    | 'heartbeat'
    | 'job'
    | 'job-create'
    | 'jobs'
    | 'licenses'
    | 'mcp'
    | 'memory'
    | 'network'
    | 'password'
    | 'password-create'
    | 'passwords'
    | 'plugin'
    | 'plugins'
    | 'provider'
    | 'providers'
    | 'room'
    | 'room-create'
    | 'rooms'
    | 'settings'
    | 'skill'
    | 'skill-create'
    | 'skills'
    | 'tools'
    | 'updates'
    | 'usage'
  bot?: Bot
  room?: Room
  data?: Record<string, unknown>
  title?: string
}
type Values = Record<string, string | boolean>
type RowData = Record<string, unknown>
const modes = [
  { id: 'inherit', label: 'Default' },
  { id: 'smart', label: 'Auto' },
  { id: 'manual', label: 'Manual' },
  { id: 'off', label: 'Bypass' }
]
const modeHelp: Record<string, string> = {
  inherit: 'Uses the approval setting of this daemon.',
  smart:
    "Works freely in the workspace. Steps outside it are checked by the bot's model; only risky ones ask first.",
  manual: 'Reads freely. Every file change and command asks first.',
  off: 'No prompts and no sandbox.'
}
/** What each tool lets a bot do, as the web app words it. */
const TOOLS: { key: string; label: string; description: string }[] = [
  {
    key: 'terminal',
    label: 'Terminal',
    description: 'Run commands in a sandbox. Leaving it is checked first, except in Bypass.'
  },
  { key: 'files', label: 'Files', description: 'Read, write and search files in the workspace.' },
  {
    key: 'code_execution',
    label: 'Code execution',
    description: 'Run scripts in a sandbox for data work and quick checks.'
  },
  { key: 'browser', label: 'Browser', description: 'Drive a local Chrome window.' },
  {
    key: 'computer_use',
    label: 'Computer use',
    description:
      "Work on your bots' shared Linux desktop, which you can watch and take over. Uses Cua."
  },
  { key: 'vision', label: 'Vision', description: 'Look at images you attach.' },
  {
    key: 'voice',
    label: 'Voice',
    description: 'Speak replies with the built-in voice. Premium voice is a connector.'
  },
  {
    key: 'message_bots',
    label: 'Message other bots',
    description: 'Ask your other bots for help, one to one.'
  },
  { key: 'delegate', label: 'Delegate', description: 'Hand a subtask to a copy of itself.' },
  { key: 'scheduling', label: 'Scheduling', description: 'Create reminders and recurring jobs.' }
]
const num = (value: string | boolean | undefined) => {
  if (value === '' || value === undefined) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0)
    throw new Error('Enter a whole number of zero or more.')
  return parsed
}
const str = (v: unknown) => (v == null ? '' : String(v))
/** A bot as the Plugins cards name it. */
type PluginBot = { name: string; display_name: string }
const keyOf = (plugin: Plugin) => `${plugin.kind}:${plugin.id}`
/** Who a plugin is on for, in a few words. */
const pluginBots = (plugin: Plugin, bots: PluginBot[]) => {
  const on = bots.filter(b => plugin.bots.includes(b.name))
  if (!on.length) return 'Off'
  if (on.length === bots.length) return bots.length === 1 ? 'On' : 'Every bot'
  if (on.length <= 2) return on.map(b => b.display_name).join(' and ')
  return `${on.length} bots`
}
/** Who may use a saved login, in a few words; null is every bot. */
const passwordBots = (login: PasswordLogin, bots: PluginBot[]) => {
  if (login.bots === null) return 'Every bot'
  const on = bots.filter(b => login.bots?.includes(b.name))
  if (!on.length) return 'No bots'
  if (on.length <= 2) return on.map(b => b.display_name).join(' and ')
  return `${on.length} bots`
}
const PASSWORD_STORE_TEXT: Record<string, string> = {
  file: "The vault's key is in a file on the daemon's computer that only you can read.",
  keychain: "The vault's key is in the keychain of the daemon's computer.",
  locked: "Hexbot can't read the vault's key. Unlock the keychain on the daemon's computer.",
  secret_service: "The vault's key is in the keyring of the daemon's computer."
}
/** How big the bots' shared computer is; a new size applies when it is reset. */
function ComputerSize({ mobile }: { mobile: ReturnType<typeof useMobile> }) {
  const status = mobile.computer
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void mobile.computerCall().catch((e: unknown) => setError(String(e)))
  }, [])
  if (!status?.sizes) return error ? <Text tone="danger">{error}</Text> : null
  return (
    <Group
      title="Computer size"
      footer={
        status.state === 'absent'
          ? 'Shared by all your bots. Used when the computer is made.'
          : "Shared by all your bots. A new size applies after Reset, on the bots' computer card."
      }
    >
      {status.sizes.map(size => (
        <ChoiceRow
          key={size.name}
          title={`${size.name[0]!.toUpperCase()}${size.name.slice(1)}`}
          subtitle={`${size.cpu} CPUs, ${size.memory_gb} GB`}
          selected={status.size === size.name}
          disabled={mobile.connection !== 'connected'}
          testID={`computer-size-${size.name}`}
          onPress={() =>
            void mobile
              .computerCall('hexbot.computer.configure', { size: size.name })
              .catch((e: unknown) => setError(String(e)))
          }
        />
      ))}
    </Group>
  )
}
export function Management({
  panel: requested,
  onClose,
  onBack,
  onNavigate,
  mobile,
  onSaved,
  onOpenRoom
}: {
  panel: Panel | null
  onClose: () => void
  /** Returns to the card this one was opened from; leave out on the first card. */
  onBack?: () => void
  /** Opens a card; `draft` keeps unsaved edits on the card being left. */
  onNavigate: (p: Panel, draft?: Values) => void
  mobile: ReturnType<typeof useMobile>
  onSaved?: () => void
  onOpenRoom?: (room: Room) => void
}) {
  const theme = useTheme()
  const [rows, setRows] = useState<RowData[]>([])
  const [values, setValues] = useState<Values>({})
  const [extra, setExtra] = useState<RowData>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadedPanel, setLoadedPanel] = useState<Panel | null>(null)
  // While a closed card slides away it keeps showing what it showed.
  const panel = requested ?? loadedPanel
  const panelLoading = loading || loadedPanel !== panel
  const epoch = useRef(0)
  const rpc: Rpc = mobile.rpc
  // Cards keep a snapshot; read the latest copy so a card returned to is current.
  const bot = panel?.bot
    ? (mobile.bots.find(b => b.name === panel.bot!.name) ?? panel.bot)
    : undefined
  // A Check-ins conversation from before the heartbeat, which can be deleted, unlike its chat.
  const checkinsSection = mobile.sections.find(s => s.bot === bot?.name && s.purpose === 'checkins')
  const room = panel?.room
    ? (mobile.rooms.find(r => r.id === panel.room!.id) ?? panel.room)
    : undefined
  const kind = panel?.kind ?? ''
  // The primary bot first, as on the web.
  const pluginRoster: PluginBot[] = [...mobile.bots]
    .sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)))
    .map(b => ({ name: b.name, display_name: b.display_name || b.name }))
  const run = async (action: () => Promise<unknown>, close = false) => {
    const current = epoch.current
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      await mobile.refresh()
      if (current !== epoch.current) return
      setNotice(previous => previous ?? 'Saved')
      onSaved?.()
      if (close) (onBack ?? onClose)()
      else if (
        [
          'devices',
          'skills',
          'jobs',
          'dreams',
          'heartbeat',
          'network',
          'usage',
          'updates',
          'plugins',
          'plugin',
          'passwords',
          'password'
        ].includes(kind)
      )
        await load()
    } catch (e) {
      if (current === epoch.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (current === epoch.current) setBusy(false)
    }
  }
  const load = async () => {
    const current = epoch.current
    let data: RowData[] = []
    let fields: Values = {}
    let detail: RowData = {}
    switch (kind) {
      case 'settings':
        fields = Object.fromEntries(
          Object.entries(mobile.settings ?? {})
            .filter(
              ([, v]) => typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number'
            )
            .map(([k, v]) => [k, typeof v === 'number' ? String(v) : v])
        ) as Values
        break
      case 'bot-create':
        fields = {
          name: '',
          display_name: '',
          title: '',
          description: '',
          persona: '',
          provider: str(mobile.settings?.default_model).split('/')[0] ?? '',
          model: str(mobile.settings?.default_model).split('/').slice(1).join('/'),
          reasoning_effort: ''
        }
        break
      case 'bot':
        if (bot)
          fields = {
            name: bot.name,
            display_name: bot.display_name,
            title: bot.title,
            description: bot.description,
            persona: bot.persona,
            provider: bot.provider ?? '',
            model: bot.model ?? '',
            reasoning_effort: bot.reasoning_effort ?? '',
            approval_mode: bot.approval_mode ?? 'inherit',
            workdir: bot.workdir ?? '',
            dream_enabled: bot.dream_enabled,
            notify: bot.notify ?? true
          }
        break
      case 'memory': {
        const result = await rpc('hexbot.memory.bot.get', { bot: bot?.name })
        fields = { memory_md: str(result.memory_md) }
        break
      }
      case 'about': {
        const result = await rpc('hexbot.memory.user.get')
        fields = { text: str(result.text) }
        break
      }
      case 'tools':
        break
      case 'rooms':
        data = (await rpc<{ rooms: Room[] }>('hexbot.rooms.list', { include_archived: true }))
          .rooms as unknown as RowData[]
        break
      case 'room-create':
        fields = { name: '', main_bot: '' }
        break
      case 'room':
        if (room)
          fields = {
            name: room.name,
            main_bot: room.main_bot ?? '',
            approval_mode: room.approval_mode ?? 'inherit',
            bot_turns_per_human_turn: str(room.limits.bot_turns_per_human_turn),
            budget_tokens_per_human_turn: str(room.limits.budget_tokens_per_human_turn)
          }
        break
      case 'providers':
        data = (await rpc<{ providers: RowData[] }>('hexbot.providers.list')).providers
        break
      case 'provider':
        fields = { key: '' }
        break
      case 'network': {
        const result = await rpc('hexbot.network.get')
        fields = { lan_enabled: result.lan_enabled === true }
        detail = result
        break
      }
      case 'devices':
        data = (await rpc<{ devices: Device[] }>('hexbot.devices.list'))
          .devices as unknown as RowData[]
        break
      case 'usage':
        detail = await rpc('hexbot.usage.summary')
        break
      case 'connectors':
        data = (
          await rpc<{ connectors: Connector[] }>(
            'hexbot.connectors.list',
            bot ? { bot: bot.name } : {}
          )
        ).connectors as unknown as RowData[]
        break
      case 'connector':
        fields = { provider: str(panel?.data?.provider) }
        break
      case 'plugins':
        data = pluginRows(await rpc<PluginsList>('hexbot.plugins.list')) as unknown as RowData[]
        break
      case 'passwords': {
        const list = await rpc<{ logins: PasswordLogin[]; store: string | null }>(
          'hexbot.passwords.list'
        )
        data = list.logins as unknown as RowData[]
        detail = { store: list.store }
        break
      }
      case 'password': {
        // Fresh from the daemon, so a card returned to shows the current bots.
        const opened = panel?.data as unknown as PasswordLogin | undefined
        const { logins } = await rpc<{ logins: PasswordLogin[] }>('hexbot.passwords.list')
        const login = logins.find(l => l.id === opened?.id) ?? opened
        detail = { login }
        fields = {
          title: str(login?.title),
          url: str(login?.url),
          username: str(login?.username),
          password: '',
          code: '',
          notes: str(login?.notes)
        }
        break
      }
      case 'password-create':
        fields = { title: '', url: '', username: '', password: '', code: '', notes: '' }
        break
      case 'plugin': {
        // Fresh from the daemon, so a card returned to shows the current bots.
        const opened = panel?.data as unknown as Plugin | undefined
        const plugins = pluginRows(await rpc<PluginsList>('hexbot.plugins.list'))
        detail = {
          plugin: plugins.find(p => opened && keyOf(p) === keyOf(opened)) ?? panel?.data
        }
        break
      }
      case 'mcp':
        fields = {
          name: '',
          transport: 'http',
          url: '',
          command: '',
          args: '',
          description: '',
          skill: ''
        }
        break
      case 'skills':
        data = (
          await rpc<{ skills: RowData[] }>('hexbot.skills.list', bot ? { bot: bot.name } : {})
        ).skills
        break
      case 'skill': {
        const result = await rpc('hexbot.skills.get', {
          name: panel?.data?.name,
          ...(bot ? { bot: bot.name } : {})
        })
        fields = {
          content: str(result.content),
          name: str(result.name),
          category: str(panel?.data?.category)
        }
        break
      }
      case 'skill-create':
        fields = { name: '', category: '', content: '---\ndescription: \n---\n\n' }
        break
      case 'dreams':
        data = (await rpc<{ dreams: RowData[] }>('hexbot.dreaming.list', { bot: bot?.name })).dreams
        detail = await rpc('hexbot.dreaming.status', { bot: bot?.name })
        break
      case 'heartbeat':
        detail = await rpc('hexbot.heartbeat.status', { bot: bot?.name })
        data = (detail.recent as RowData[] | undefined) ?? []
        fields = { text: str(detail.text) }
        break
      case 'connect':
        detail = await rpc('hexbot.connect.status')
        break
      case 'updates':
        detail = await rpc('hexbot.update.status')
        fields = { version: '' }
        break
      case 'jobs': {
        if (bot)
          data = (
            await rpc<{ jobs: RowData[] }>('hexbot.jobs.list', {
              bot: bot.name,
              include_disabled: true
            })
          ).jobs.map(j => ({ ...j, bot: bot.name }))
        else
          data = (
            await Promise.all(
              mobile.bots.map(async b =>
                (
                  await rpc<{ jobs: RowData[] }>('hexbot.jobs.list', {
                    bot: b.name,
                    include_disabled: true
                  })
                ).jobs.map(j => ({ ...j, bot: b.name }))
              )
            )
          ).flat()
        break
      }
      case 'job':
      case 'job-create':
        fields = {
          name: str(panel?.data?.name),
          bot: str(bot?.name ?? panel?.data?.bot ?? mobile.bots[0]?.name),
          prompt: str(panel?.data?.prompt),
          schedule: str((panel?.data?.schedule as RowData)?.display ?? 'every day at 8:00'),
          script: str(panel?.data?.script),
          workdir: str(panel?.data?.workdir),
          provider: str(panel?.data?.provider),
          model: str(panel?.data?.model),
          reasoning_effort: str(panel?.data?.reasoning_effort),
          repeat: str((panel?.data?.repeat as RowData)?.times),
          skills: ((panel?.data?.skills as string[]) ?? []).join(', ')
        }
        break
      case 'activity':
        data = (await rpc<{ messages: RowData[] }>('hexbot.activity.list', { limit: 100 })).messages
        break
    }
    if (['bot', 'bot-create'].includes(kind) && panel?.data?.draft)
      fields = { ...fields, ...(panel.data.draft as Values) }
    if (current === epoch.current) {
      setRows(data)
      // A plugin card reloads after each action; keep values typed but not
      // yet saved. It opens empty, and Save values clears them itself.
      if (kind !== 'plugin') setValues(fields)
      setExtra(detail)
    }
  }
  useEffect(() => {
    epoch.current++
    if (!requested) return
    setRows([])
    setValues({})
    setExtra({})
    setError(null)
    setNotice(null)
    setBusy(false)
    setLoading(true)
    const current = epoch.current
    void load()
      .catch(e => {
        if (current === epoch.current) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (current === epoch.current) {
          setLoading(false)
          setLoadedPanel(requested)
        }
      })
    return () => {
      epoch.current++
    }
    // A panel is a snapshot; changing it loads a fresh form.
  }, [requested])
  // A heartbeat starts or ends, or the bot changes its checklist, while the card is open.
  useEffect(() => {
    if (kind !== 'heartbeat' || panelLoading) return
    const current = epoch.current
    const shown = str(extra.text)
    // A newer change reads again; this answer may arrive after it.
    let newer = false
    void rpc<RowData>('hexbot.heartbeat.status', { bot: bot?.name })
      .then(detail => {
        if (newer || current !== epoch.current) return
        setRows((detail.recent as RowData[] | undefined) ?? [])
        setExtra(detail)
        // Unsaved edits stay.
        setValues(v => (v.text === shown ? { ...v, text: str(detail.text) } : v))
      })
      .catch(() => {})
    return () => {
      newer = true
    }
  }, [mobile.heartbeats])
  const set = (key: string, value: string | boolean) => setValues(v => ({ ...v, [key]: value }))
  const field = (
    key: string,
    label: string,
    multiline = false,
    hint?: string,
    secret = false,
    maxLength?: number
  ) => (
    <Field
      key={key}
      label={label}
      testID={`field-${key}`}
      value={str(values[key])}
      onChangeText={v => set(key, v)}
      multiline={multiline}
      hint={hint}
      secureTextEntry={secret}
      autoCapitalize="none"
      autoCorrect={!secret && multiline}
      maxLength={maxLength}
    />
  )
  const toggle = (key: string, label: string) => (
    <SwitchRow
      key={key}
      title={label}
      testID={`toggle-${key}`}
      value={values[key] === true}
      onValueChange={v => set(key, v)}
      disabled={busy || mobile.connection !== 'connected'}
    />
  )
  const keepDraft = ['bot', 'bot-create'].includes(kind) ? values : undefined
  const navigate = (next: Panel['kind'], data?: RowData) =>
    onNavigate({ kind: next, bot, room, data }, keepDraft)
  const row = (title: string, next: Panel['kind'], subtitle?: string, data?: RowData) => (
    <Row
      key={next}
      title={title}
      subtitle={subtitle}
      testID={`manage-${next}`}
      chevron
      onPress={() => navigate(next, data)}
      disabled={busy || mobile.connection !== 'connected'}
    />
  )
  const action = (
    label: string,
    fn: () => Promise<unknown>,
    destructive = false,
    detail = '',
    unavailable = false
  ) => (
    <Row
      key={label}
      title={label}
      testID={`action-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
      destructive={destructive}
      disabled={unavailable || busy || mobile.connection !== 'connected'}
      onPress={() =>
        destructive
          ? confirm(label, detail || 'This change applies to the selected daemon.', () => {
              void run(fn)
            })
          : void run(fn)
      }
    />
  )
  const chooseMode = (key: string, inherit = true) => {
    const options = modes.filter(m => inherit || m.id !== 'inherit')
    const selected = str(values[key]) || (inherit ? 'inherit' : 'smart')
    return (
      <Group title="Approvals" footer={modeHelp[selected]}>
        <View style={styles.segment}>
          <Segmented
            onChange={value => set(key, value)}
            options={options.map(m => ({ key: m.id, label: m.label }))}
            selected={selected}
            testID="mode"
          />
        </View>
      </Group>
    )
  }
  let save: (() => Promise<unknown>) | undefined
  let content: React.ReactNode
  switch (kind) {
    case 'settings':
      save = () =>
        rpc('hexbot.settings.set', {
          patch: {
            approval_mode: values.approval_mode,
            workspace_dir: values.workspace_dir,
            dream_enabled: values.dream_enabled,
            dream_time: values.dream_time,
            // A daemon from before the heartbeat has no such setting.
            ...(typeof mobile.settings?.heartbeat_enabled === 'boolean'
              ? { heartbeat_enabled: values.heartbeat_enabled }
              : {}),
            default_model: values.default_model || null,
            fallback_model: values.fallback_model || null,
            bot_daily_token_budget: num(values.bot_daily_token_budget),
            room_bot_turns_per_human_turn: num(values.room_bot_turns_per_human_turn),
            room_budget_tokens_per_human_turn: num(values.room_budget_tokens_per_human_turn)
          }
        })
      content = (
        <>
          {chooseMode('approval_mode', false)}
          <Group title="Models" footer="Provider/model, such as anthropic/claude-sonnet-5.">
            <View style={styles.inset}>
              {field('default_model', 'Default for new bots')}
              {field('fallback_model', 'Fallback when a provider fails')}
            </View>
          </Group>
          {field('workspace_dir', 'Workspace on the daemon')}
          <Group title="Budgets" footer="Leave a budget empty for no limit.">
            <View style={styles.inset}>
              {field('bot_daily_token_budget', 'Daily tokens for each bot')}
              {field('room_bot_turns_per_human_turn', 'Bot replies per room message')}
              {field('room_budget_tokens_per_human_turn', 'Tokens per room message')}
            </View>
          </Group>
          <Group
            title="Dreaming"
            footer="Each night, bots fold the day's conversations into their memory."
          >
            {toggle('dream_enabled', 'Dreaming')}
            <View style={styles.inset}>
              {field(
                'dream_time',
                'Dream time',
                false,
                '24-hour time on the daemon, such as 03:00'
              )}
            </View>
          </Group>
          {typeof mobile.settings?.heartbeat_enabled === 'boolean' ? (
            <Group
              title="Heartbeat"
              footer="Every 30 minutes, day and night, each bot works through its checklist and writes in its chat only when something needs you."
            >
              {toggle('heartbeat_enabled', 'Heartbeat')}
            </Group>
          ) : null}
        </>
      )
      break
    case 'bot-create':
    case 'bot':
      save = async () => {
        const params = {
          name: values.name,
          display_name: values.display_name,
          title: values.title,
          description: values.description,
          persona: values.persona,
          // Without a model the daemon uses its default.
          ...(values.provider && values.model
            ? { provider: values.provider, model: values.model }
            : {}),
          reasoning_effort: values.reasoning_effort || null,
          ...(bot
            ? {
                approval_mode: values.approval_mode,
                workdir: values.workdir || null,
                dream_enabled: values.dream_enabled,
                notify: values.notify
              }
            : {})
        }
        const result = await rpc<{ bot: Bot; section?: Section }>(
          bot ? 'hexbot.bots.update' : 'hexbot.bots.create',
          params
        )
        if (!bot && result.section) await mobile.openSection(result.bot, result.section)
        return result
      }
      content = (
        <>
          <View style={[styles.identity, { backgroundColor: theme.surface }]}>
            <BotFace
              face={bot?.face}
              imageUri={botPhoto(bot)}
              name={str(values.display_name) || str(values.name) || 'New bot'}
              size={88}
            />
            {bot ? (
              <View style={styles.pictureActions}>
                <Button
                  disabled={busy || mobile.connection !== 'connected'}
                  icon="image-outline"
                  label={botPhoto(bot) ? 'Change photo' : 'Use a photo'}
                  onPress={() =>
                    void run(async () => {
                      const file = await pickFile(
                        ['image/png', 'image/jpeg', 'image/webp'],
                        2000000
                      )
                      if (!file) return
                      const result = await rpc<{ bot: Bot }>('hexbot.bots.update', {
                        name: bot.name,
                        avatar: file.base64
                      })
                      onNavigate({ kind: 'bot', bot: result.bot, data: { draft: values } })
                    })
                  }
                  style={styles.smallButton}
                  testID="action-choose-bot-picture"
                  variant="secondary"
                />
                {botPhoto(bot) ? (
                  <Button
                    disabled={busy || mobile.connection !== 'connected'}
                    label="Use its face"
                    onPress={() =>
                      void run(async () => {
                        const result = await rpc<{ bot: Bot }>('hexbot.bots.update', {
                          name: bot.name,
                          avatar: null
                        })
                        onNavigate({ kind: 'bot', bot: result.bot, data: { draft: values } })
                      })
                    }
                    style={styles.smallButton}
                    testID="action-use-generated-face"
                    variant="plain"
                  />
                ) : null}
              </View>
            ) : (
              <Text align="center" tone="muted" variant="footnote">
                Its face comes from its name. You can add a photo after it is created.
              </Text>
            )}
          </View>
          <View style={styles.stack}>
            {!bot
              ? field('name', 'Bot name', false, 'Lowercase letters, numbers and hyphens.')
              : null}
            {field('display_name', 'Name')}
            {field('title', 'Role', false, 'One line, such as Chief of staff.')}
            {field(
              'description',
              'Description',
              true,
              'Shown under its name in your bot list.',
              false,
              400
            )}
          </View>
          {field(
            'persona',
            'Soul',
            true,
            `${str(values.display_name) || 'The bot'} can edit its soul too and says when it does. Your chat takes changes after it summarises older messages.`,
            false,
            4000
          )}
          <Group title="Model" footer="Applies from the next message.">
            <View style={styles.inset}>
              <ModelPill
                disabled={busy || mobile.connection !== 'connected'}
                models={mobile.models}
                onChange={next =>
                  setValues(v => ({
                    ...v,
                    ...(next.provider !== undefined ? { provider: next.provider } : {}),
                    ...(next.model !== undefined ? { model: next.model } : {}),
                    ...(next.reasoning !== undefined ? { reasoning_effort: next.reasoning } : {})
                  }))
                }
                rpc={rpc}
                testID="manage-models"
                value={{
                  model: str(values.model),
                  provider: str(values.provider),
                  reasoning: str(values.reasoning_effort)
                }}
              />
            </View>
          </Group>
          {bot ? (
            <>
              {chooseMode('approval_mode')}
              {field(
                'workdir',
                'Workspace on the daemon',
                false,
                'Leave empty to use the daemon workspace.'
              )}
              <Group title="What it can use">
                {row('Tools', 'tools', `${bot.tools.length} on`)}
                {row('Connectors', 'connectors')}
                {row('Skills', 'skills', bot.skills.length ? `${bot.skills.length} on` : undefined)}
              </Group>
              <Group title="What it remembers">
                {row('Memory', 'memory')}
                {toggle('dream_enabled', 'Dreaming')}
                {row('Dreaming history', 'dreams')}
                {row('Scheduled jobs', 'jobs')}
              </Group>
              {typeof mobile.settings?.heartbeat_enabled === 'boolean' ? (
                <Group title="On its own">{row('Heartbeat', 'heartbeat')}</Group>
              ) : null}
              <Group title="Notifications">{toggle('notify', 'Notify me')}</Group>
              <Group>
                {action('Clear stopped status', () =>
                  rpc('hexbot.bots.clear_status', { name: bot.name })
                )}
                {bot.primary === false && !mobile.bots.some(b => b.primary)
                  ? action('Make primary', async () => {
                      const result = await rpc<{ bot: Bot }>('hexbot.bots.set_primary', {
                        name: bot.name
                      })
                      // The bot's chat takes the new tools with its next message. An
                      // older daemon makes a new section, as its older ones keep theirs.
                      const { section } = await rpc<{ section: Section }>(
                        'hexbot.sections.create',
                        { bot: bot.name }
                      )
                      await mobile.openSection(result.bot, section)
                    })
                  : null}
                {checkinsSection
                  ? action(
                      'Delete earlier check-ins',
                      async () => {
                        await rpc('hexbot.sections.delete', { id: checkinsSection.id })
                        await mobile.refresh()
                      },
                      true,
                      'This deletes what check-ins told you before the heartbeat replaced them.'
                    )
                  : null}
                {/* The primary bot stays; the daemon refuses to delete it too. */}
                {bot.primary
                  ? null
                  : action(
                      'Delete bot',
                      async () => {
                        await rpc('hexbot.bots.delete', { name: bot.name })
                        mobile.back()
                        onClose()
                      },
                      true,
                      'This deletes the bot, its chat, memory and scheduled jobs.'
                    )}
              </Group>
            </>
          ) : null}
        </>
      )
      break
    case 'memory':
      save = () => rpc('hexbot.memory.bot.set', { bot: bot?.name, memory_md: values.memory_md })
      content = field('memory_md', 'Bot memory', true)
      break
    case 'licenses':
      content = <Licenses />
      break
    case 'about':
      save = () => rpc('hexbot.memory.user.set', { text: values.text })
      content = field('text', 'About you', true, 'Every bot you own reads this.', false, 2000)
      break
    case 'tools': {
      const available = bot?.available_tools as string[] | undefined
      content = (
        <Group
          footer={`What ${bot?.display_name ?? 'this bot'} can do on this computer. Tools this computer isn't set up for don't appear. Changes apply from the next message.`}
        >
          {TOOLS.filter(tool => !available || available.includes(tool.key)).map(tool => (
            <SwitchRow
              key={tool.key}
              title={tool.label}
              subtitle={tool.description}
              testID={`tool-${tool.key}`}
              value={(bot?.tools as string[] | undefined)?.includes(tool.key) ?? false}
              disabled={busy || mobile.connection !== 'connected'}
              onValueChange={enabled => {
                if (bot)
                  void run(async () => {
                    const result = await rpc<{ bot: Bot }>('hexbot.bots.update', {
                      name: bot.name,
                      tools: enabled
                        ? [...bot.tools, tool.key]
                        : bot.tools.filter(t => t !== tool.key)
                    })
                    onNavigate({ kind: 'tools', bot: result.bot })
                  })
              }}
            />
          ))}
        </Group>
      )
      if ((bot?.tools as string[] | undefined)?.includes('computer_use'))
        content = (
          <>
            {content}
            <ComputerSize mobile={mobile} />
          </>
        )
      break
    }
    case 'rooms':
      content = (
        <Group>
          {rows.map(r => (
            <Row
              key={str(r.id)}
              title={str(r.name)}
              subtitle={r.archived_at ? 'Archived' : `${(r.members as unknown[]).length} members`}
              testID={`managed-room-${r.id}`}
              chevron
              onPress={() =>
                onOpenRoom && !r.archived_at
                  ? onOpenRoom(r as unknown as Room)
                  : onNavigate({ kind: 'room', room: r as unknown as Room })
              }
            />
          ))}
        </Group>
      )
      break
    case 'room-create':
    case 'room': {
      const joined = (name: string) =>
        room
          ? room.members.some(m => m.member_kind === 'bot' && m.member_id === name && !m.left_at)
          : values[`member-${name}`] === true
      // A main bot that has left the room since reads as none, and the daemon clears it on save.
      const mainBot = joined(str(values.main_bot)) ? str(values.main_bot) : ''
      save = async () => {
        const members = mobile.bots.filter(b => joined(b.name)).map(b => b.name)
        const result = await rpc<{ room: Room }>(
          room ? 'hexbot.rooms.update' : 'hexbot.rooms.create',
          {
            ...(room
              ? {
                  id: room.id,
                  limits: {
                    bot_turns_per_human_turn: num(values.bot_turns_per_human_turn),
                    budget_tokens_per_human_turn: num(values.budget_tokens_per_human_turn)
                  },
                  approval_mode: values.approval_mode
                }
              : { members }),
            name: values.name,
            main_bot: mainBot || null
          }
        )
        if (!room) await mobile.openRoom(result.room)
        return result
      }
      content = (
        <>
          {field('name', 'Room name')}
          <Group
            title="Main bot"
            footer="Answers when nobody is mentioned. Mention a bot with @ to ask it directly. Only bots in the room can be its main bot."
          >
            {[
              { name: '', display_name: 'No main bot' },
              ...mobile.bots.filter(b => joined(b.name))
            ].map(b => (
              <ChoiceRow
                key={b.name || 'none'}
                title={b.display_name}
                testID={`main-bot-${b.name || 'none'}`}
                selected={mainBot === b.name}
                onPress={() => set('main_bot', b.name)}
              />
            ))}
          </Group>
          <Group title="Bots">
            {mobile.bots.map(b => {
              return (
                <SwitchRow
                  key={b.name}
                  title={b.display_name}
                  testID={`member-${b.name}`}
                  value={joined(b.name)}
                  disabled={busy || mobile.connection !== 'connected'}
                  leading={<BotFace name={b.display_name} size={28} />}
                  onValueChange={enabled => {
                    if (!room) {
                      // A bot that leaves the new room cannot stay its main bot.
                      if (!enabled && str(values.main_bot) === b.name) set('main_bot', '')
                      return set(`member-${b.name}`, enabled)
                    }
                    const change = () =>
                      void run(async () => {
                        const updated = await rpc<{ room: Room & { deleted?: boolean } }>(
                          enabled ? 'hexbot.rooms.add_member' : 'hexbot.rooms.remove_member',
                          { id: room.id, bot: b.name }
                        )
                        // Removing the last bot deleted the room; the refresh leaves it.
                        if (updated.room.deleted) return onClose()
                        onNavigate({ kind: 'room', room: updated.room })
                      })
                    const last = !room.members.some(
                      m => m.member_kind === 'bot' && m.member_id !== b.name && !m.left_at
                    )
                    if (enabled || !last) return change()
                    confirm(
                      'Remove and delete room',
                      `${b.display_name} is the last bot here. Removing it deletes this room, its transcript and the memory made from it. The bot itself stays.`,
                      change
                    )
                  }}
                />
              )
            })}
          </Group>
          {room ? (
            <>
              {chooseMode('approval_mode')}
              <Group title="Budgets" footer="Leave a budget empty to use the daemon setting.">
                <View style={styles.inset}>
                  {field('bot_turns_per_human_turn', 'Bot replies per message')}
                  {field('budget_tokens_per_human_turn', 'Tokens per message')}
                </View>
              </Group>
              <Group>
                {action(room.archived_at ? 'Restore room' : 'Archive room', async () => {
                  await rpc(room.archived_at ? 'hexbot.rooms.unarchive' : 'hexbot.rooms.archive', {
                    id: room.id
                  })
                  // Archiving the open room leaves it; restoring keeps whatever is open.
                  if (!room.archived_at && isOpenRoom(mobile.route, room.id)) mobile.back()
                  onClose()
                })}
                {action(
                  'Delete room',
                  async () => {
                    await rpc('hexbot.rooms.delete', { id: room.id })
                    if (isOpenRoom(mobile.route, room.id)) mobile.back()
                    onClose()
                  },
                  true,
                  'This deletes this room and its history.'
                )}
              </Group>
            </>
          ) : null}
        </>
      )
      break
    }
    case 'providers':
      content = (
        <Group>
          {rows.map(p => (
            <Row
              key={str(p.id)}
              title={str(p.label)}
              subtitle={p.configured ? 'Connected' : 'Not connected'}
              testID={`provider-${p.id}`}
              chevron
              onPress={() => navigate('provider', p)}
            />
          ))}
        </Group>
      )
      break
    case 'provider': {
      const provider = str(panel?.data?.id)
      content = (
        <>
          <Text>{str(panel?.data?.label)}</Text>
          <>
            {field('key', 'API key', false, undefined, true)}
            <Group>
              {action('Save API key', () =>
                rpc('hexbot.providers.set_key', { provider, key: values.key })
              )}
              {action('Sign in', async () => {
                const login = await rpc('hexbot.providers.login_start', { provider })
                setExtra(login)
                if (login.message) setNotice(str(login.message))
                if (login.url) await Linking.openURL(str(login.url))
              })}
              {extra.login_id ? (
                <>
                  {extra.code ? <Text selectable>{str(extra.code)}</Text> : null}
                  {action('Check sign-in', async () => {
                    const login = await rpc('hexbot.providers.login_poll', {
                      login_id: extra.login_id
                    })
                    setNotice(str(login.message || login.status))
                    setExtra({ ...extra, ...login })
                  })}
                  {action('Cancel sign-in', () =>
                    rpc('hexbot.providers.login_cancel', { login_id: extra.login_id })
                  )}
                </>
              ) : null}
              {action(
                'Disconnect provider',
                () => rpc('hexbot.providers.clear_key', { provider }),
                true
              )}
            </Group>
          </>
        </>
      )
      break
    }
    case 'network':
      content = (
        <>
          <Group>
            <SwitchRow
              title="Allow local connections"
              testID="network-lan"
              value={values.lan_enabled === true}
              disabled={busy || mobile.connection !== 'connected'}
              onValueChange={value =>
                confirm(
                  value ? 'Allow local connections' : 'Turn off local connections',
                  value
                    ? 'Paired devices can connect over LAN and Tailscale.'
                    : 'Local clients will disconnect. Use Hex Connect to return from this phone.',
                  () => void run(() => rpc('hexbot.network.set', { lan_enabled: value }))
                )
              }
            />
          </Group>
          <Group
            footer={
              values.lan_enabled === true
                ? undefined
                : 'Turn on local connections to pair another device.'
            }
          >
            {((extra.addresses as string[]) ?? []).map((a, i) => (
              <Row key={a} title={a} testID={`address-${i}`} />
            ))}
            {action(
              'Create pairing code',
              async () => {
                const code = await rpc('hexbot.pairing.code')
                setNotice(`${code.code}\n${code.link}`)
              },
              false,
              '',
              values.lan_enabled !== true
            )}
          </Group>
        </>
      )
      break
    case 'devices':
      content = (
        <Group>
          {rows.map(d => (
            <Row
              key={str(d.id)}
              title={str(d.name)}
              subtitle={d.current ? 'This device' : str(d.platform)}
              testID={`device-${d.id}`}
              destructive
              onPress={() =>
                confirm(
                  'Revoke device',
                  d.current
                    ? 'This phone will disconnect and need pairing again.'
                    : 'This device will need pairing again.',
                  () => void run(() => rpc('hexbot.devices.revoke', { id: d.id }))
                )
              }
            />
          ))}
        </Group>
      )
      break
    case 'usage':
      content = (
        <Group>
          <Row title="Input tokens" meta={str(extra.input_tokens ?? 0)} testID="usage-input" />
          <Row title="Output tokens" meta={str(extra.output_tokens ?? 0)} testID="usage-output" />
          <Row
            title="Estimated cost"
            meta={`$${Number(extra.estimated_cost_usd ?? 0).toFixed(4)}`}
            testID="usage-cost"
          />
        </Group>
      )
      break
    case 'connectors':
      content = (
        <Group>
          {row('Add MCP server', 'mcp')}
          {rows.map(c => (
            <Row
              key={str(c.id)}
              title={str(c.name)}
              subtitle={str(c.state_text)}
              testID={`connector-${c.id}`}
              chevron
              onPress={() => navigate('connector', c)}
            />
          ))}
        </Group>
      )
      break
    case 'connector': {
      const c = panel!.data as unknown as Connector
      content = (
        <>
          <Text tone="muted">{c.description}</Text>
          {c.providers?.length ? (
            <Group title="Provider">
              {c.providers.map(p => (
                <ChoiceRow
                  key={p.id}
                  title={p.label}
                  testID={`connector-provider-${p.id}`}
                  selected={values.provider === p.id}
                  onPress={() => set('provider', p.id)}
                />
              ))}
            </Group>
          ) : null}
          {c.fields
            .filter(f => !f.provider || f.provider === values.provider)
            .map(f =>
              field(
                f.key,
                f.label,
                false,
                [f.help, f.set ? 'Already saved. Leave empty to keep it.' : '']
                  .filter(Boolean)
                  .join(' '),
                f.secret
              )
            )}
          <Group>
            {bot ? (
              <SwitchRow
                title="Enabled for this bot"
                testID="connector-enabled"
                value={c.enabled_for_bot === true}
                onValueChange={enabled =>
                  void run(async () => {
                    await rpc('hexbot.connectors.set_for_bot', { id: c.id, bot: bot.name, enabled })
                    onNavigate({ ...panel!, data: { ...panel!.data, enabled_for_bot: enabled } })
                  })
                }
              />
            ) : null}
            {action('Save credentials', () =>
              rpc('hexbot.connectors.setup', {
                id: c.id,
                provider: values.provider || undefined,
                ...(bot ? { bot: bot.name } : {}),
                values: Object.fromEntries(
                  c.fields
                    .filter(f => values[f.key] !== undefined && values[f.key] !== '')
                    .map(f => [f.key, values[f.key]])
                )
              })
            )}
            {action('Test connector', async () => {
              const result = await rpc('hexbot.connectors.test', {
                id: c.id,
                ...(bot ? { bot: bot.name } : {})
              })
              setNotice(str(result.message))
            })}
            {action('Clear credentials', () => rpc('hexbot.connectors.clear', { id: c.id }), true)}
            {c.mcp
              ? action(
                  'Remove MCP server',
                  () => rpc('hexbot.connectors.remove_mcp', { name: c.mcp?.name }),
                  true
                )
              : null}
          </Group>
        </>
      )
      break
    }
    case 'mcp':
      save = () => {
        const mcp =
          values.transport === 'http'
            ? { url: values.url }
            : { command: values.command, args: str(values.args).split('\n').filter(Boolean) }
        // Saved from a bot's settings, the server goes to that bot.
        if (bot)
          return rpc('hexbot.connectors.add_mcp', {
            name: values.name,
            transport: values.transport,
            bot: bot.name,
            ...mcp
          })
        const name = str(values.name).trim()
        const about = str(values.description).trim()
        const skill = str(values.skill).trim()
        return rpc('hexbot.plugins.install', {
          name,
          description: about,
          mcp,
          // JSON strings are valid YAML, so any description survives the frontmatter.
          ...(skill
            ? {
                skills: [
                  {
                    // Skill names stop at 64 characters, like plugin names.
                    name: `${name.slice(0, 58)}-guide`,
                    content: `---\ndescription: ${JSON.stringify(about || `How to use the ${name} MCP server.`)}\n---\n${skill}\n`
                  }
                ]
              }
            : {})
        })
      }
      content = (
        <>
          {field('name', 'Server name')}
          <Group>
            {['http', 'stdio'].map(t => (
              <ChoiceRow
                key={t}
                title={t === 'http' ? 'Streamable HTTP' : 'Command on the daemon'}
                testID={`mcp-${t}`}
                selected={values.transport === t}
                onPress={() => set('transport', t)}
              />
            ))}
          </Group>
          {values.transport === 'http' ? (
            field('url', 'Server URL')
          ) : (
            <>
              {field('command', 'Command')}
              {field('args', 'Arguments', true, 'One argument per line.')}
            </>
          )}
          {bot ? null : (
            <>
              {field('description', 'What it is for')}
              {field(
                'skill',
                'Skill for your bots',
                true,
                'Optional. How bots should use this server: which tools to call and what to avoid.'
              )}
              <Text tone="muted" variant="footnote">
                On for every bot. Add tokens on the server's card once it is added.
              </Text>
            </>
          )}
        </>
      )
      break
    case 'plugins': {
      const bots = pluginRoster
      const plugins = rows as unknown as Plugin[]
      const servers = plugins.filter(p => p.category === 'mcp')
      const skills = plugins.filter(
        p => p.kind === 'skill' || (p.kind === 'package' && p.category !== 'mcp')
      )
      const item = (p: Plugin) => (
        <Row
          key={keyOf(p)}
          title={p.name}
          subtitle={`${p.state_text} · ${pluginBots(p, bots)}`}
          testID={`plugin-${keyOf(p)}`}
          chevron
          onPress={() => navigate('plugin', p as unknown as RowData)}
        />
      )
      content = (
        <>
          <Text tone="muted">
            Everything your bots can use beyond their own tools. Open one to choose its bots.
          </Text>
          <Group
            title="Connectors"
            footer="Services Hexbot supports. Keys are stored once on this daemon."
          >
            {plugins.filter(p => p.kind === 'connector' && p.category !== 'mcp').map(item)}
          </Group>
          <Group
            title="MCP servers"
            footer="Servers you or your bots add. A bot that needs one asks you first."
          >
            {row('Add MCP server', 'mcp')}
            {servers.map(item)}
          </Group>
          <Group title="Skills">
            {row('Create skill', 'skill-create')}
            {skills.map(item)}
          </Group>
          <Group
            title="Built-in tools"
            footer="Tools that need a program on the daemon's computer."
          >
            {plugins.filter(p => p.kind === 'capability').map(item)}
          </Group>
        </>
      )
      break
    }
    case 'plugin': {
      const bots = pluginRoster
      const p = (extra.plugin ?? panel!.data) as unknown as Plugin
      // One that isn't set up can be taken away from bots, not given to them. A
      // connector or skill can be ready for one bot through its own key, so
      // only the daemon can tell; a built-in tool is the same for all.
      const unready = !p.ready && p.kind === 'capability'
      const server = p.server
      const values_ = server ? (server.transport === 'http' ? server.headers : server.env) : []
      const valueKind = server?.transport === 'http' ? 'headers' : 'env'
      // `run` reloads this card after each change. Only bots that still exist
      // are sent: one deleted elsewhere while the card was open would make the
      // daemon refuse the whole change.
      const choose = (next: string[]) =>
        void run(() =>
          rpc('hexbot.plugins.set_bots', {
            kind: p.kind,
            id: p.id,
            bots: next.filter(name => bots.some(b => b.name === name))
          })
        )
      content = (
        <>
          <Text tone="muted">{p.description}</Text>
          <Text tone={p.state === 'error' ? 'danger' : 'muted'} variant="footnote">
            {p.state_text}
          </Text>
          <Group
            title="Bots"
            footer={unready ? `Set it up before you give it to a bot. ${p.state_text}` : undefined}
          >
            {bots.map(b => (
              <SwitchRow
                key={b.name}
                title={b.display_name}
                testID={`plugin-bot-${b.name}`}
                value={p.bots.includes(b.name)}
                disabled={
                  (unready && !p.bots.includes(b.name)) || busy || mobile.connection !== 'connected'
                }
                onValueChange={on =>
                  choose(on ? [...p.bots, b.name] : p.bots.filter(name => name !== b.name))
                }
              />
            ))}
          </Group>
          {server ? (
            <Group
              title={valueKind === 'headers' ? 'Headers' : 'Environment'}
              footer={server.url ?? [server.command, ...(server.args ?? [])].join(' ')}
            >
              <View style={styles.inset}>
                {values_.map(v =>
                  field(
                    `value:${v.key}`,
                    v.key,
                    false,
                    v.set
                      ? `Saved${v.hint ? ` ${v.hint}` : ''}. Leave empty to keep it.`
                      : 'Not set',
                    true
                  )
                )}
                {field(
                  'new_key',
                  valueKind === 'headers' ? 'New header' : 'New environment value',
                  false,
                  valueKind === 'headers' ? 'Such as Authorization' : 'Such as API_TOKEN'
                )}
                {field('new_value', 'Value', false, undefined, true)}
              </View>
              {action('Save values', async () => {
                const change: Record<string, string> = Object.fromEntries(
                  values_
                    .filter(v => str(values[`value:${v.key}`]).trim())
                    .map(v => [v.key, str(values[`value:${v.key}`])])
                )
                const added = str(values.new_key).trim()
                if (added) change[added] = str(values.new_value)
                await rpc('hexbot.plugins.configure', {
                  kind: p.kind,
                  id: p.id,
                  [valueKind]: change
                })
                setValues({})
              })}
              {values_.map(v =>
                action(`Remove ${v.key}`, () =>
                  rpc('hexbot.plugins.configure', {
                    kind: p.kind,
                    id: p.id,
                    [valueKind]: { [v.key]: null }
                  })
                )
              )}
            </Group>
          ) : null}
          {p.skills?.length ? (
            <Group title="Skills">
              {p.skills.map(skill => (
                <Row
                  key={skill.name}
                  title={skill.name}
                  subtitle={skill.description}
                  testID={`plugin-skill-${skill.name}`}
                />
              ))}
            </Group>
          ) : null}
          <Group>
            {p.kind === 'connector' && p.connector
              ? row(
                  p.state === 'not_set_up' ? 'Set up' : 'Keys and provider',
                  'connector',
                  undefined,
                  p.connector as unknown as RowData
                )
              : null}
            {p.kind === 'skill' && p.disabled_globally
              ? action('Undo Off for every bot', () =>
                  rpc('hexbot.skills.set_global', { name: p.id, enabled: true })
                )
              : null}
            {p.kind === 'skill'
              ? row('Skill instructions', 'skill', undefined, {
                  name: p.name,
                  category: p.category
                })
              : null}
            {p.connector && (p.kind !== 'connector' || p.state !== 'not_set_up')
              ? action('Test', async () => {
                  const result = await rpc('hexbot.connectors.test', { id: p.connector!.id })
                  setNotice(str(result.message))
                })
              : null}
            {p.kind === 'package' || (p.kind === 'connector' && server)
              ? action(
                  `Remove ${p.name}`,
                  async () => {
                    // A package goes with its server and skills; a server added
                    // on its own goes where it was added.
                    await (p.kind === 'package'
                      ? rpc('hexbot.plugins.remove', { kind: 'package', id: p.id })
                      : rpc('hexbot.connectors.remove_mcp', { name: p.name }))
                    ;(onBack ?? onClose)()
                  },
                  true,
                  'It is removed for every bot.'
                )
              : null}
          </Group>
        </>
      )
      break
    }
    case 'passwords': {
      const logins = rows as unknown as PasswordLogin[]
      const store = str(extra.store)
      content = (
        <>
          <Text tone="muted">
            Sign-ins your bots use for you. A bot has Hexbot type them into a page and never sees
            them.
          </Text>
          <Group footer={store ? PASSWORD_STORE_TEXT[store] : undefined}>
            {row('Add password', 'password-create')}
            {logins.map(login => (
              <Row
                key={login.id}
                title={login.title}
                subtitle={[login.site, login.username, passwordBots(login, pluginRoster)]
                  .filter(Boolean)
                  .join(' · ')}
                testID={`password-${login.id}`}
                chevron
                onPress={() => navigate('password', login as unknown as RowData)}
              />
            ))}
          </Group>
          {logins.length ? null : (
            <Text tone="muted" variant="footnote">
              When a bot needs to sign in somewhere, it asks you in its chat.
            </Text>
          )}
        </>
      )
      break
    }
    case 'password-create':
    case 'password': {
      const login = (extra.login ?? panel?.data) as unknown as PasswordLogin | undefined
      const editing = kind === 'password' && login
      save = () => {
        const change: Record<string, unknown> = {
          title: str(values.title),
          url: str(values.url).trim(),
          username: str(values.username),
          notes: str(values.notes)
        }
        if (editing) change.id = login.id
        if (str(values.password)) change.password = str(values.password)
        if (str(values.code).trim()) change.code = str(values.code)
        return rpc('hexbot.passwords.save', change)
      }
      const bots = pluginRoster
      const every = editing ? login.bots === null : true
      const on = (name: string) => every || Boolean(login?.bots?.includes(name))
      // Not through `run`: reloading the card would drop unsaved edits. Busy
      // holds the switches until the answer, which only this card may take.
      const share = (next: string[] | null) => {
        const current = epoch.current
        setBusy(true)
        setError(null)
        void rpc<{ login: PasswordLogin }>('hexbot.passwords.set_bots', {
          id: login!.id,
          bots: next
        })
          .then(result => {
            if (current === epoch.current)
              setExtra(previous => ({ ...previous, login: result.login }))
          })
          .catch(e => {
            if (current === epoch.current) setError(e instanceof Error ? e.message : String(e))
          })
          .finally(() => {
            if (current === epoch.current) setBusy(false)
          })
      }
      const revealed = extra.revealed as { password: string; code: string | null } | undefined
      content = (
        <>
          {field('url', 'Site', false, 'Such as https://app.schoology.com')}
          {field('title', 'Name')}
          {field('username', 'Username or email')}
          {field(
            'password',
            'Password',
            false,
            editing ? 'Leave empty to keep it.' : undefined,
            true
          )}
          {field(
            'code',
            'One-time code key (optional)',
            false,
            editing && login.has_code
              ? 'Leave empty to keep it.'
              : 'The setup key or otpauth:// link',
            true
          )}
          {field('notes', 'Notes', true)}
          {editing ? (
            <>
              <Group title="Bots" footer={every ? 'Every bot, and bots you add later.' : undefined}>
                <SwitchRow
                  title="Every bot"
                  testID="password-every-bot"
                  value={every}
                  disabled={busy || mobile.connection !== 'connected'}
                  onValueChange={value => share(value ? null : [])}
                />
                {bots.map(b => (
                  <SwitchRow
                    key={b.name}
                    title={b.display_name}
                    testID={`password-bot-${b.name}`}
                    value={on(b.name)}
                    disabled={busy || mobile.connection !== 'connected'}
                    onValueChange={value =>
                      share(
                        value
                          ? [...(login.bots ?? []), b.name]
                          : bots.map(x => x.name).filter(x => x !== b.name && on(x))
                      )
                    }
                  />
                ))}
              </Group>
              <Group>
                {revealed ? (
                  // All of it, selectable to copy: a row would cut a long one off.
                  <View style={styles.inset} testID="password-revealed">
                    <Text selectable variant="body">
                      {revealed.password}
                    </Text>
                    <Text tone="muted" variant="footnote">
                      {revealed.code ? `Password. One-time code ${revealed.code}` : 'Password'}
                    </Text>
                  </View>
                ) : (
                  <Row
                    title="Show password"
                    testID="action-show-password"
                    disabled={busy || mobile.connection !== 'connected'}
                    onPress={() => {
                      // Not through `run`: reloading the card would hide it again.
                      // Only this card takes the answer, and a one-time code
                      // goes when it expires.
                      const current = epoch.current
                      void rpc<{
                        password: string
                        code: { code: string; valid_for: number } | null
                      }>('hexbot.passwords.reveal', { id: login.id })
                        .then(shown => {
                          if (current !== epoch.current) return
                          setExtra(previous => ({
                            ...previous,
                            revealed: { password: shown.password, code: shown.code?.code ?? null }
                          }))
                          if (shown.code)
                            setTimeout(() => {
                              if (current === epoch.current)
                                setExtra(previous => ({ ...previous, revealed: undefined }))
                            }, shown.code.valid_for * 1000)
                        })
                        .catch(e => {
                          if (current === epoch.current)
                            setError(e instanceof Error ? e.message : String(e))
                        })
                    }}
                  />
                )}
                {login.has_code
                  ? action('Remove one-time code', () =>
                      rpc('hexbot.passwords.save', { id: login.id, code: '' })
                    )
                  : null}
                {action(
                  'Delete password',
                  async () => {
                    await rpc('hexbot.passwords.delete', { id: login.id })
                    ;(onBack ?? onClose)()
                  },
                  true,
                  'Your bots can no longer sign in with it.'
                )}
              </Group>
            </>
          ) : null}
        </>
      )
      break
    }
    case 'skills':
      content = (
        <Group>
          {row('Create skill', 'skill-create')}
          {rows.map(s => {
            // Waiting for setup: bots can't use it, so the switch can't give it.
            const missing = s.ready === false ? ((s.missing as SkillRequirement[]) ?? []) : null

            return (
              <View key={str(s.name)}>
                <Row
                  title={str(s.name)}
                  subtitle={str(s.description)}
                  testID={`skill-${s.name}`}
                  chevron
                  onPress={() => navigate('skill', s)}
                />
                <SwitchRow
                  title={`Enable ${s.name}`}
                  subtitle={missing?.length ? requirementText(missing) : undefined}
                  testID={`enable-skill-${s.name}`}
                  value={s.enabled === true}
                  disabled={busy || mobile.connection !== 'connected' || !!missing}
                  onValueChange={enabled =>
                    void run(() =>
                      rpc(bot ? 'hexbot.skills.set_for_bot' : 'hexbot.skills.set_global', {
                        name: s.name,
                        ...(bot ? { bot: bot.name } : {}),
                        enabled
                      })
                    )
                  }
                />
              </View>
            )
          })}
        </Group>
      )
      break
    case 'skill':
    case 'skill-create':
      save = () =>
        rpc('hexbot.skills.save', {
          name: values.name,
          content: values.content,
          category: values.category || '',
          ...(bot ? { bot: bot.name } : {})
        })
      content = (
        <>
          {kind === 'skill-create' ? field('name', 'Skill name') : null}
          {field('category', 'Category')}
          {field('content', 'Skill instructions', true)}
          {kind === 'skill' ? (
            <Group>
              {bot
                ? action('Share skill to library', () =>
                    rpc('hexbot.skills.share', { name: values.name, bot: bot.name })
                  )
                : null}
              {action(
                'Delete skill',
                () =>
                  rpc('hexbot.skills.delete', {
                    name: values.name,
                    ...(bot ? { bot: bot.name } : {})
                  }),
                true
              )}
            </Group>
          ) : null}
        </>
      )
      break
    case 'dreams':
      content = (
        <>
          <Group>
            {action('Dream now', () => rpc('hexbot.dreaming.run_now', { bot: bot?.name }))}
            <Row
              title="Next dream"
              subtitle={str(extra.next_run_at || 'Off')}
              testID="dream-next"
            />
          </Group>
          {rows.map(d => (
            <Group key={str(d.id)} title={str(d.status)}>
              <Text selectable>{str(d.summary)}</Text>
              {action(
                'Restore memory before this dream',
                () => rpc('hexbot.dreaming.restore', { id: d.id }),
                true,
                'The current memory will be replaced. The daemon records the replacement so it can be restored too.'
              )}
            </Group>
          ))}
        </>
      )
      break
    case 'heartbeat': {
      const name = bot?.display_name ?? 'The bot'
      const enabled = extra.enabled !== false
      const next = extra.running
        ? 'Running now'
        : !enabled
          ? 'Off'
          : extra.empty
            ? 'Add a check to start'
            : extra.next_run_at
              ? new Date(str(extra.next_run_at)).toLocaleString()
              : 'Not scheduled'
      save = () => rpc('hexbot.heartbeat.set', { bot: bot?.name, text: values.text })
      content = (
        <>
          {field(
            'text',
            'HEARTBEAT.md',
            true,
            `One check per line. Every ${str(extra.every_minutes || 30)} minutes, day and night, ${name} works through this list and writes in its chat only when something needs you. Ask it in its chat to keep an eye on something and it adds a line too.`,
            false,
            Number(extra.cap) || 4000
          )}
          <Group
            footer={
              enabled ? undefined : 'Heartbeats are off for every bot. Turn them on in Settings.'
            }
          >
            <Row title="Next heartbeat" subtitle={next} testID="heartbeat-next" />
            {action(
              'Run now',
              () => rpc('hexbot.heartbeat.run_now', { bot: bot?.name }),
              false,
              '',
              extra.empty === true || extra.running === true || values.text !== extra.text
            )}
          </Group>
          {rows.map(r => (
            <Group
              key={str(r.id)}
              title={`${r.kind === 'manual' ? 'You asked' : 'Heartbeat'} · ${new Date(str(r.started_at)).toLocaleString()}`}
            >
              <View style={styles.inset}>
                <Text selectable>
                  {r.status === 'running'
                    ? 'Running'
                    : r.status === 'failed'
                      ? `Failed: ${str(r.summary)}`
                      : `${r.messaged ? 'Posted in your chat' : 'Nothing to tell you'}${r.summary ? `. ${str(r.summary)}` : ''}`}
                </Text>
              </View>
            </Group>
          ))}
        </>
      )
      break
    }
    case 'connect':
      content = (
        <>
          <Group>
            <Row
              title={extra.registered ? 'Connected' : 'Not connected'}
              subtitle={str(extra.tunnel_hostname || extra.last_error)}
              testID="connect-state"
            />
            {extra.registered
              ? action(
                  'Disconnect Hex Connect',
                  async () => {
                    await rpc('hexbot.connect.disconnect')
                    setExtra(await rpc('hexbot.connect.status'))
                  },
                  true,
                  'Remote connections through Hex Connect will close.'
                )
              : action('Register this daemon', async () => {
                  const registration = await rpc('hexbot.connect.register_start')
                  setExtra(registration)
                  setNotice(`Code: ${registration.user_code}`)
                  await Linking.openURL(str(registration.verify_url))
                })}
            {extra.device_code
              ? action('Check registration', async () => {
                  const result = await rpc('hexbot.connect.register_poll', {
                    device_code: extra.device_code
                  })
                  setNotice(str(result.status))
                  if (result.status !== 'pending') setExtra(await rpc('hexbot.connect.status'))
                })
              : null}
          </Group>
        </>
      )
      break
    case 'updates':
      content = (
        <>
          <Group>
            <Row title={str(extra.status)} subtitle={str(extra.message)} testID="update-state" />
            <Row title="Current version" meta={str(extra.version)} testID="update-version" />
          </Group>
          {extra.capability ? (
            <>
              {field('version', 'Version to install')}
              {action(
                'Update daemon',
                () => rpc('hexbot.update.request', { version: values.version }),
                true,
                'The daemon will install this released version and restart. Running work may be interrupted.'
              )}
            </>
          ) : (
            <Text tone="muted">
              This daemon runs from source. Update its checkout on its computer.
            </Text>
          )}
        </>
      )
      break
    case 'jobs':
      content = (
        <Group>
          {row('Create scheduled job', 'job-create')}
          {rows.map(j => (
            <Row
              key={str(j.id)}
              title={str(j.name)}
              subtitle={`${j.bot}, ${j.enabled ? str((j.schedule as RowData)?.display) : 'Paused'}`}
              testID={`job-${j.id}`}
              chevron
              onPress={() => navigate('job', j)}
            />
          ))}
        </Group>
      )
      break
    case 'job':
    case 'job-create': {
      // A job belongs to its bot; a different bot means a new job.
      const jobBot = kind === 'job' ? str(panel?.data?.bot) : str(values.bot)
      save = () =>
        rpc(kind === 'job' ? 'hexbot.jobs.update' : 'hexbot.jobs.create', {
          bot: jobBot,
          ...(kind === 'job' ? { job_id: panel?.data?.id } : {}),
          name: values.name,
          prompt: values.prompt,
          ...scheduleChange(
            str(values.schedule),
            kind === 'job' ? str((panel?.data?.schedule as RowData)?.display) : undefined
          ),
          script: values.script || null,
          workdir: values.workdir || null,
          provider: values.provider || null,
          model: values.model || null,
          reasoning_effort: values.reasoning_effort || null,
          skills: str(values.skills)
            .split(',')
            .map(s => s.trim())
            .filter(Boolean),
          repeat: num(values.repeat)
        })
      content = (
        <>
          {field('name', 'Job name')}
          {kind === 'job' ? (
            <Group>
              <Row
                testID="job-bot"
                title="Bot"
                meta={mobile.bots.find(b => b.name === jobBot)?.display_name || jobBot}
              />
            </Group>
          ) : (
            field('bot', 'Bot name')
          )}
          {field('prompt', 'Instructions', true)}
          {field(
            'schedule',
            'Schedule',
            false,
            'For example every 2h, every day at 8:00, or a five-field cron schedule.'
          )}
          {field('script', 'Script on the daemon', false, 'Optional. Relative to the workspace.')}
          {field('workdir', 'Workspace on the daemon')}
          {field('provider', 'Provider override')}
          {field('model', 'Model override')}
          {field('reasoning_effort', 'Reasoning effort')}
          {field('skills', 'Skills', false, 'Comma-separated skill names.')}
          {field('repeat', 'Number of runs', false, 'Leave empty to repeat indefinitely.')}
          {kind === 'job' ? (
            <Group title="Last run">
              <Row
                testID="job-last-status"
                title="Status"
                meta={str(panel?.data?.last_status) || 'Not run yet'}
              />
              {panel?.data?.last_error ? (
                <Text selectable tone="danger">
                  {str(panel.data.last_error)}
                </Text>
              ) : null}
              {panel?.data?.last_output ? (
                <Text selectable>
                  {str(panel.data.last_output).slice(0, 12000)}
                  {str(panel.data.last_output).length > 12000
                    ? '\nOutput truncated. Read the full output on the daemon.'
                    : ''}
                </Text>
              ) : null}
            </Group>
          ) : null}
          {kind === 'job' ? (
            <Group>
              {action(panel?.data?.enabled ? 'Pause job' : 'Resume job', async () => {
                const result = await rpc(
                  'hexbot.jobs.' + (panel?.data?.enabled ? 'pause' : 'resume'),
                  { bot: jobBot, job_id: panel?.data?.id }
                )
                onNavigate({ ...panel!, data: { ...(result.job as RowData), bot: jobBot } })
              })}
              {action('Run job now', () =>
                rpc('hexbot.jobs.run', { bot: jobBot, job_id: panel?.data?.id })
              )}
              {action(
                'Delete job',
                async () => {
                  await rpc('hexbot.jobs.remove', { bot: jobBot, job_id: panel?.data?.id })
                  navigate('jobs')
                },
                true
              )}
            </Group>
          ) : null}
        </>
      )
      break
    }
    case 'activity':
      content = (
        <Group>
          {rows.map((m, i) => (
            <Row
              key={str(m.id ?? i)}
              title={`${m.from_bot} to ${m.to_bot}`}
              subtitle={str(m.text)}
              subtitleLines={5}
              testID={`activity-${i}`}
            />
          ))}
        </Group>
      )
      break
    default:
      content = null
  }
  const titles: Record<string, string> = {
    settings: 'Daemon settings',
    'bot-create': 'New bot',
    bot: bot ? `Edit ${bot.display_name}` : 'Edit bot',
    memory: 'Memory',
    about: 'About you',
    licenses: 'Licenses',
    tools: 'Tools',
    rooms: 'All rooms',
    'room-create': 'New room',
    room: room?.name ?? 'Room',
    providers: 'Models',
    provider: str(panel?.data?.label),
    network: 'Network and pairing',
    devices: 'Paired devices',
    usage: 'Usage',
    connectors: 'Connectors',
    connector: str(panel?.data?.name),
    mcp: 'Add MCP server',
    plugins: 'Plugins',
    plugin: str(panel?.data?.name),
    passwords: 'Passwords',
    password: str(panel?.data?.title),
    'password-create': 'New password',
    skills: 'Skills',
    skill: str(panel?.data?.name),
    'skill-create': 'Create skill',
    dreams: 'Dreaming',
    heartbeat: 'Heartbeat',
    connect: 'Hex Connect',
    updates: 'Daemon updates',
    jobs: 'Scheduled jobs',
    job: 'Scheduled job',
    'job-create': 'New scheduled job',
    activity: 'Bot activity'
  }
  const empty: Record<string, string> = {
    devices: 'No paired devices.',
    skills: 'No skills yet.',
    jobs: 'No scheduled jobs yet.',
    activity: 'No messages between bots yet.',
    dreams: 'No dreams yet.',
    heartbeat: 'No heartbeats yet.',
    rooms: 'No rooms yet.'
  }
  return (
    <Layer
      visible={!!requested}
      onClose={onClose}
      onBack={onBack}
      title={titles[kind] || 'Settings'}
      testID="management-sheet"
      action={
        save && !panelLoading
          ? {
              label: kind === 'bot-create' ? 'Create' : 'Save',
              busy,
              disabled: mobile.connection !== 'connected',
              onPress: () => void run(save!, true)
            }
          : undefined
      }
    >
      <Form>
        {error ? <Banner message={error} tone="danger" testID="management-error" /> : null}
        {notice ? (
          <Text selectable tone="muted" testID="management-notice">
            {notice}
          </Text>
        ) : null}
        {panelLoading ? (
          <Text tone="muted" testID="management-loading">
            Loading…
          </Text>
        ) : (
          content
        )}
        {!panelLoading && rows.length === 0 && empty[kind] ? (
          <Text tone="muted">{empty[kind]}</Text>
        ) : null}
        {busy ? <Text tone="muted">Working…</Text> : null}
      </Form>
    </Layer>
  )
}

const styles = StyleSheet.create({
  identity: { alignItems: 'center', borderRadius: radius.panel, gap: 12, padding: 18 },
  inset: { gap: 14, paddingHorizontal: 16, paddingVertical: 14 },
  pictureActions: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    justifyContent: 'center'
  },
  segment: { padding: 6 },
  smallButton: { minHeight: 40, paddingHorizontal: 16 },
  stack: { gap: 16 }
})
