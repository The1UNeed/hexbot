import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArrowRight, ArrowUp, Plus } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { UsageDataSummary } from '../app/settings/privacy'
import { ConnectorFields, connectorValues } from '../components/connector-fields'
import { isSubscription, ProviderPanel, supportsApiKey } from '../components/provider-panel'
import { Avatar } from '../components/ui/avatar'
import { Button } from '../components/ui/button'
import { Chip } from '../components/ui/chip'
import { ConnectorIcon } from '../components/ui/connector-icon'
import type { HexbotActName } from '../components/ui/hexbot-act'
import { Input } from '../components/ui/input'
import { Select } from '../components/ui/select'
import { Switch } from '../components/ui/switch'
import { Textarea } from '../components/ui/textarea'
import { HexbotMark, Wordmark } from '../components/ui/wordmark'
import {
  botsCreate,
  botsCreatePrimary,
  botsList,
  connectorsList,
  connectorsSetup,
  providerModels,
  providersList,
  settingsGet,
  settingsSet,
  userMemoryGet,
  userMemorySet
} from '../lib/api'
import { avatarPng, type AvatarStyle, botFace, styleForName } from '../lib/avatar-builder'
import { type DaemonProgress, getBridge, hasLocalRuntime, isElectron } from '../lib/bridge'
import { cn } from '../lib/cn'
import { connectTo, setLocalDaemonPort } from '../lib/connection'
import type {
  Bot,
  BotCreateInput,
  BotFace,
  Connector,
  ModelOption,
  Provider,
  Section
} from '../lib/types'
import { useChatSelection } from '../lib/use-chat-selection'
import { useBots } from '../stores/bots'
import { useConnection } from '../stores/connection'
import { unknownMethod, useMe } from '../stores/me'
import { introduceBot, oneChat, sectionsActions } from '../stores/sections'
import { type LastSection, uiActions } from '../stores/ui'

export const Route = createFileRoute('/onboarding')({ component: OnboardingPage })

type OnboardingStep =
  | 'about'
  | 'choice'
  | 'connect'
  | 'continue'
  | 'deciding'
  | 'defaults'
  | 'install'
  | 'jobs'
  | 'meet'
  | 'providers'
  | 'tools'
  | 'usage'
  | 'welcome'

export function initialOnboardingStep(input: {
  connected: boolean
  hasLocalRuntime: boolean
  isElectron: boolean
}): OnboardingStep {
  if (!input.connected && input.isElectron) {
    // The client-only package has nothing to install, so the only way in is
    // to pair with a daemon.
    return input.hasLocalRuntime ? 'choice' : 'connect'
  }

  // Connected: what comes next depends on the daemon (About you, bots), so
  // the page reads both before it shows anything.
  return 'deciding'
}

/**
 * The bot onboarding ends with for someone who already has bots: the one
 * they were with, else one they have talked to, else the first.
 */
export function landingBot(bots: Bot[]): Bot | undefined {
  const last = uiActions().lastSection

  return (
    bots.find(bot => bot.name === last?.bot) ??
    bots.find(bot => bot.sections_recent.length) ??
    bots[0]
  )
}

/**
 * Where onboarding ends for someone who already has bots: the chat of
 * `landingBot` as the daemon names it, never the section remembered here,
 * which the upgrade may have deleted or recovery set aside. An older daemon
 * names no chat, so there the section they were in stays theirs. Null when
 * there are no bots yet, or when an older daemon asked which section to
 * continue and the user picked none.
 */
export async function landingSection(
  bots: Bot[],
  current: () => boolean = () => true
): Promise<LastSection | null> {
  const bot = landingBot(bots)

  if (!bot || !current()) {
    return null
  }

  const last = uiActions().lastSection

  if (last?.bot === bot.name && !(await oneChat())) {
    return current() ? last : null
  }

  if (!current()) {
    return null
  }

  const section = await sectionsActions().chat(bot.name, current)

  return current() && section ? { bot: bot.name, section: section.id } : null
}

/**
 * Where someone with bots waits when their chat did not open: an older
 * daemon asked which section to continue and they picked none, or the daemon
 * failed. Continue asks again; nothing is opened or made until then.
 */
export function ContinueStep({
  bot,
  error,
  onContinue
}: {
  bot: Bot
  error: null | string
  onContinue: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)

  return (
    <SetupFrame subtitle="Pick up where you left off." title={`Continue with ${bot.display_name}`}>
      <div className="grid w-full flex-1 place-items-center py-8">
        <Avatar {...botFace(bot)} name={bot.display_name} size="xl" />
      </div>
      <SetupActions className="pb-[12vh]">
        <Button
          busy={busy}
          className={PILL}
          onClick={() => {
            setBusy(true)
            void onContinue().finally(() => setBusy(false))
          }}
          variant="primary"
        >
          Continue
        </Button>
      </SetupActions>
      {error ? (
        <p className="pb-10 text-center text-secondary text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </SetupFrame>
  )
}

/** The primary bot, else a bot called hexbot, with its chat. */
async function existingHexBot(): Promise<{ bot: Bot; section: Section } | null> {
  const { bots } = await botsList()
  const bot = bots.find(item => item.primary) ?? bots.find(item => item.name === 'hexbot')
  const section = bot ? await sectionsActions().chat(bot.name) : null

  return bot && section ? { bot, section } : null
}

/**
 * Creates HexBot, the primary bot. A daemon from before the primary bot
 * gets an ordinary bot with the same name, which it can promote once updated.
 * When HexBot is already there, as after a create whose reply was lost, it
 * returns HexBot and its chat instead.
 */
export function createHexBot(
  defaultModel: null | string,
  avatar: null | string,
  face?: BotFace
): Promise<{ bot: Bot; section: Section }> {
  const [provider, ...rest] = defaultModel?.split('/') ?? []
  const model = provider && rest.length ? { model: rest.join('/'), provider } : {}
  // A face describes its picture, so it goes only with one.
  const input = { ...(avatar ? { avatar, face } : {}), ...model }

  return botsCreatePrimary(input)
    .catch(reason => {
      if (!unknownMethod(reason)) {
        throw reason
      }

      return botsCreate({ ...input, display_name: 'HexBot', name: 'hexbot' } as BotCreateInput)
    })
    .catch(async reason => {
      // 4214: there is already a primary bot. 4208: a bot called hexbot exists.
      const code = (reason as { code?: number } | null)?.code
      const found = code === 4214 || code === 4208 ? await existingHexBot() : null

      if (!found) {
        throw reason
      }

      return found
    })
}

/**
 * The first thing a new install shows: the mark, the name, one line on what
 * Hexbot is, and one way forward. Everything else waits behind that button.
 */
export function WelcomeStep({ onStart }: { onStart: () => void }) {
  return (
    <div className="hex-rise flex flex-col items-center text-center">
      <Wordmark size="lg" />
      <p className="mt-7 max-w-[24rem] text-[20px] leading-snug text-foreground/85">
        Your team of bots, always on, on your own machine.
      </p>
      <Button
        autoFocus
        className="mt-9 h-10 px-6 text-[16px] font-normal"
        data-testid="onboarding-get-started"
        onClick={onStart}
        variant="pill"
      >
        Get started
        <ArrowRight size={15} strokeWidth={2.25} />
      </Button>
    </div>
  )
}

/** Every page after the welcome screen: the title in one place, one column. */
function SetupFrame({
  children,
  subtitle,
  title
}: {
  children: ReactNode
  subtitle?: string
  title: string
}) {
  return (
    <main className="relative flex min-h-screen flex-col items-center bg-background px-6 text-foreground">
      <div aria-hidden className="hex-drag absolute inset-x-0 top-0 h-11" />
      <div className="hex-rise flex w-full max-w-[520px] flex-1 flex-col items-center" key={title}>
        <h1 className="pt-[13vh] text-center text-[22px] leading-snug font-medium">{title}</h1>
        {subtitle ? <p className="mt-1 text-center text-secondary text-muted">{subtitle}</p> : null}
        {children}
      </div>
    </main>
  )
}

const PILL = 'h-9 w-full rounded-full'

/** The stacked buttons under every page, primary first. */
function SetupActions({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto flex w-56 flex-col gap-2', className)}>{children}</div>
}

/** A tour page: a title up top, one illustration, and stacked buttons below. */
function TourPage({
  back,
  children,
  next,
  title
}: {
  back?: () => void
  children: ReactNode
  next: () => void
  title: string
}) {
  return (
    <SetupFrame title={title}>
      <div className="grid w-full flex-1 place-items-center py-8">{children}</div>
      <SetupActions className="pb-[12vh]">
        <Button className={PILL} data-testid="onboarding-next" onClick={next} variant="primary">
          Next
        </Button>
        {back ? (
          <Button className={PILL} onClick={back} variant="secondary">
            Back
          </Button>
        ) : null}
      </SetupActions>
    </SetupFrame>
  )
}

/** Install stages in order, with a rough share of the total time each takes. */
const STAGES: { acts: HexbotActName[]; id: string; label: string; weight: number }[] = [
  { acts: ['catch', 'download'], id: 'runtime', label: 'Unpacking Hexbot', weight: 20 },
  { acts: ['catch', 'download', 'fish'], id: 'uv', label: 'Fetching the installer', weight: 5 },
  { acts: ['type', 'read', 'tinker'], id: 'python', label: 'Installing Python', weight: 35 },
  {
    acts: [
      'type',
      'tinker',
      'juggle',
      'hammer',
      'coffee',
      'lift',
      'drum',
      'read',
      'dance',
      'wand',
      'balloon'
    ],
    id: 'dependencies',
    label: 'Installing voice tools',
    weight: 35
  },
  { acts: ['horn', 'flag', 'rocket'], id: 'done', label: 'Starting the daemon', weight: 5 }
]

/** Space around a 132px mark for an act's props, which reach past the face. */
const ACT_ROOM = 'mx-[46px] mt-[53px] mb-[13px]'

/** How long Hexbot keeps one act up before trying the next in the stage. */
const ACT_MS = 6000

/**
 * Overall install percentage. A stage that reports its own percent uses it;
 * one that only logs lines creeps toward its end, so the bar never sits still
 * and never runs backwards.
 */
export function installPercent(progress: DaemonProgress[]): number {
  const last = progress.findLast(item => STAGES.some(stage => stage.id === item.stage))

  if (!last) {
    return 0
  }

  const index = STAGES.findIndex(stage => stage.id === last.stage)

  const lines = progress.filter(item => item.stage === last.stage)
  const reported = Math.max(0, ...lines.map(item => item.percent ?? 0)) / 100
  const within = last.stage === 'done' ? 0 : Math.max(reported, 1 - 1 / (1 + lines.length / 40))
  const before = STAGES.slice(0, index).reduce((sum, stage) => sum + stage.weight, 0)

  return Math.round(before + STAGES[index]!.weight * within)
}

/**
 * The install: Hexbot plays the act for the current stage, a bar shows how
 * far along it is, and under the bar is the stage and the line the installer
 * just printed. Each stage has its own acts, and a long stage works through
 * them so the page never looks stuck.
 */
export function InstallStep({
  error,
  progress
}: {
  error?: null | string
  progress: DaemonProgress[]
}) {
  const last = progress.at(-1)
  const stage = STAGES.find(item => item.id === last?.stage)
  const label = stage?.label ?? last?.message ?? 'Preparing the local runtime'
  const percent = installPercent(progress)
  const [turn, setTurn] = useState(0)

  useEffect(() => {
    setTurn(0)
    const timer = setInterval(() => setTurn(value => value + 1), ACT_MS)

    return () => clearInterval(timer)
  }, [stage])

  const acts = stage?.acts ?? STAGES[0]!.acts

  return (
    <SetupFrame title="Setting up Hexbot">
      <div className="flex w-full flex-1 flex-col items-center justify-center gap-10 py-8">
        <HexbotMark act={acts[turn % acts.length]!} className={ACT_ROOM} size={132} />
        <div className="w-full max-w-[360px]">
          <div
            aria-label="Install progress"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={percent}
            className="h-1.5 overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
          >
            <div
              className="h-full rounded-full bg-foreground transition-[width] duration-[var(--hex-motion-enter)] ease-[var(--hex-ease-out)]"
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="mt-3 flex items-baseline justify-between gap-3">
            <p className="hex-rise min-w-0 truncate" key={label} role="status">
              {label}
            </p>
            <p className="shrink-0 text-secondary text-muted tabular-nums">{percent}%</p>
          </div>
          <p className="mt-1 h-[1.4em] truncate font-mono text-meta text-muted">
            {last && last.message !== label ? last.message : ''}
          </p>
          {error ? (
            <p className="mt-3 text-secondary text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
      <details className="w-full pb-10 text-center text-secondary text-muted">
        <summary className="cursor-pointer">Install log</summary>
        <pre className="mt-2 max-h-40 overflow-y-auto text-left whitespace-pre-wrap font-mono text-meta">
          {progress.map(item => item.message).join('\n')}
        </pre>
      </details>
    </SetupFrame>
  )
}

const MEET_PROMPTS = [
  'Hand off any task to your team of bots',
  'Watch my inbox and tell me what matters',
  'Plan the launch together in a room'
]

/** Types one example request after another, the way a person would. */
function TypedPrompt() {
  const [index, setIndex] = useState(0)
  const [length, setLength] = useState(0)

  const reduced =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  useEffect(() => {
    if (reduced) {
      return
    }

    const prompt = MEET_PROMPTS[index]!

    const timer =
      length < prompt.length
        ? setTimeout(() => setLength(value => value + 1), 36)
        : setTimeout(() => {
            setLength(0)
            setIndex(value => (value + 1) % MEET_PROMPTS.length)
          }, 2400)

    return () => clearTimeout(timer)
  }, [index, length, reduced])

  return (
    <span>
      {reduced ? MEET_PROMPTS[0] : MEET_PROMPTS[index]!.slice(0, length)}
      <span
        aria-hidden
        className="hex-pulse ml-px inline-block h-[1.05em] w-px translate-y-[0.15em] bg-foreground"
      />
    </span>
  )
}

export function MeetStep({ back, next }: { back: () => void; next: () => void }) {
  return (
    <TourPage back={back} next={next} title="Meet Hexbot">
      <div className="flex flex-col items-center gap-6">
        <HexbotMark size={64} />
        <div className="w-[320px] max-w-full rounded-[22px] border border-border bg-surface px-4 pt-3 pb-2.5 shadow-popup">
          <p className="min-h-[22px] text-[length:var(--text-body)] leading-[22px]">
            <TypedPrompt />
          </p>
          <div className="mt-2 flex items-center justify-between">
            <span className="grid size-7 place-items-center rounded-full border border-border text-muted">
              <Plus size={14} />
            </span>
            <span className="grid size-7 place-items-center rounded-full bg-foreground text-background">
              <ArrowUp size={14} strokeWidth={2.5} />
            </span>
          </div>
        </div>
      </div>
    </TourPage>
  )
}

const JOBS: { label: string; place: string; style: AvatarStyle }[] = [
  {
    label: 'Release notes',
    place: 'col-start-2 row-start-1',
    style: { color: 'red', shape: 'round' }
  },
  {
    label: 'Inbox triage',
    place: 'col-start-1 row-start-2',
    style: { color: 'teal', shape: 'squircle' }
  },
  {
    label: 'Weekly report',
    place: 'col-start-3 row-start-2',
    style: { color: 'blue', shape: 'drop' }
  }
]

export function JobsStep({ back, next }: { back: () => void; next: () => void }) {
  return (
    <TourPage back={back} next={next} title="Give each bot a job">
      <div className="grid grid-cols-3 grid-rows-2 gap-x-6 gap-y-6">
        {JOBS.map((job, index) => (
          <div
            className={cn('hex-pop-in flex flex-col items-center gap-2', job.place)}
            key={job.label}
            style={{ animationDelay: `${index * 140}ms` }}
          >
            <Avatar className="size-16" name={job.label} style={job.style} />
            <Chip>{job.label}</Chip>
          </div>
        ))}
      </div>
    </TourPage>
  )
}

/** Full package only: install a daemon here, or pair with one elsewhere. */
export function ChoiceStep({
  back,
  onConnect,
  onLocal
}: {
  back: () => void
  onConnect: () => void
  onLocal: () => void
}) {
  return (
    <SetupFrame
      subtitle="Install it here, or pair with a daemon you already run."
      title="Where should Hexbot run?"
    >
      <div className="grid w-full flex-1 place-items-center py-8">
        <HexbotMark size={64} />
      </div>
      <SetupActions className="pb-[12vh]">
        <Button
          autoFocus
          className={PILL}
          data-testid="onboarding-choice-local"
          onClick={onLocal}
          variant="primary"
        >
          On this computer
        </Button>
        <Button
          className={PILL}
          data-testid="onboarding-choice-connect"
          onClick={onConnect}
          variant="secondary"
        >
          On another device
        </Button>
        <Button className={PILL} onClick={back} variant="ghost">
          Back
        </Button>
      </SetupActions>
    </SetupFrame>
  )
}

function ProvidersStep({
  onContinue,
  onError
}: {
  onContinue: (configured: Provider[]) => void
  onError: (message: string) => void
}) {
  const [providers, setProviders] = useState<Provider[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const refresh = useCallback(async () => {
    try {
      const result = await providersList()
      setProviders(result.providers)
    } catch (reason) {
      onError(String(reason))
    }
  }, [onError])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const configured = (providers ?? []).filter(item => item.configured === true)

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()

    // Connected first, then subscription sign-ins, then the long tail of keys.
    const rank = (item: Provider) => (item.configured ? 0 : isSubscription(item) ? 1 : 2)

    return (providers ?? [])
      .filter(item => !query || `${item.label} ${item.id}`.toLowerCase().includes(query))
      .sort((left, right) => rank(left) - rank(right))
  }, [providers, search])

  return (
    <div className="w-full space-y-4 py-8">
      <Input
        aria-label="Search providers"
        data-testid="onboarding-provider-search"
        onChange={event => setSearch(event.target.value)}
        placeholder="Search providers"
        value={search}
      />
      <ul className="max-h-[42vh] divide-y divide-border overflow-y-auto rounded-panel border border-border">
        {filtered.map(item => {
          const open = selected === item.id

          return (
            <li key={item.id}>
              <button
                aria-expanded={open}
                className={cn(
                  'flex w-full items-center justify-between gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent',
                  open && 'bg-surface-2'
                )}
                data-testid={`onboarding-provider-item-${item.id}`}
                onClick={() => setSelected(open ? null : item.id)}
                type="button"
              >
                <span className="font-medium">{item.label}</span>
                <Chip
                  tone={item.configured ? 'success' : isSubscription(item) ? 'accent' : 'neutral'}
                >
                  {item.configured
                    ? 'Connected'
                    : isSubscription(item)
                      ? 'Subscription'
                      : supportsApiKey(item)
                        ? 'API key'
                        : 'Setup required'}
                </Chip>
              </button>
              {open ? (
                <div className="border-t border-border bg-background px-4 py-4">
                  <ProviderPanel onConfigured={refresh} provider={item} />
                </div>
              ) : null}
            </li>
          )
        })}
        {filtered.length === 0 ? (
          <li className="px-4 py-6 text-center text-secondary text-muted">
            {providers ? 'No providers match.' : 'Loading providers'}
          </li>
        ) : null}
      </ul>
      <p className="text-center text-secondary text-muted">
        {configured.length === 0
          ? 'Connect at least one provider to continue.'
          : `${configured.length} connected. Add more now, or later in Settings.`}
      </p>
      <SetupActions>
        <Button
          className={PILL}
          data-testid="onboarding-continue"
          disabled={configured.length === 0}
          onClick={() => onContinue(configured)}
          variant="primary"
        >
          Continue
        </Button>
      </SetupActions>
    </div>
  )
}

interface ModelChoice {
  label: string
  value: string
}

async function loadModelChoices(providers: Provider[]): Promise<ModelChoice[]> {
  const lists = await Promise.all(
    providers.map(provider =>
      providerModels(provider.id)
        .then(models => ({ models, provider }))
        .catch(() => ({ models: [] as ModelOption[], provider }))
    )
  )

  return lists.flatMap(({ models, provider }) =>
    models.map(model => ({
      label: `${provider.label} · ${model.label}`,
      value: `${provider.id}/${model.id}`
    }))
  )
}

/** The daemon's cap on About you (`hexbot.memory.USER_CAP`). */
const ABOUT_CAP = 2000
/** The daemon's cap on your display name (`hexbot.users.me.set`). */
const NAME_CAP = 64

export interface AboutYou {
  name: string
  preferences: string
  work: string
}

/** The About you text the init page writes: one labelled line per answer. */
export function compileAboutYou(input: AboutYou): string {
  const lines: [string, string][] = [
    ['Name', input.name],
    ['What I do', input.work],
    ['How to talk to me', input.preferences]
  ]

  return lines
    .map(([label, value]) => ({ label, value: value.trim() }))
    .filter(line => line.value)
    .map(line => `${line.label}: ${line.value}`)
    .join('\n')
}

/**
 * The init page: who the user is and how they like to work, saved as About
 * you so every bot they own knows it from the start. Skipping saves an empty
 * text, so the page is asked once and not on every startup.
 */
export function AboutStep({
  onContinue,
  onError
}: {
  onContinue: () => void
  onError: (message: string) => void
}) {
  const [about, setAbout] = useState<AboutYou>({ name: '', preferences: '', work: '' })
  const [busy, setBusy] = useState(false)
  const text = compileAboutYou(about)

  const patch = (field: keyof AboutYou) => (event: { target: { value: string } }) =>
    setAbout(current => ({ ...current, [field]: event.target.value }))

  const save = async (value: string, name = '') => {
    setBusy(true)

    try {
      // The name you give here is the one rooms show. It goes first: once
      // About you is saved, Get Started counts as done and is not shown again.
      if (name) {
        try {
          await useMe.getState().rename(name)
        } catch (error) {
          if (!unknownMethod(error)) {
            throw error
          }
        }
      }

      await userMemorySet(value)
      onContinue()
    } catch (reason) {
      onError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="w-full space-y-5 py-8">
      <label className="block space-y-2">
        <span className="font-medium">Your name</span>
        <Input
          autoFocus
          data-testid="onboarding-about-name"
          maxLength={NAME_CAP}
          onChange={patch('name')}
          placeholder="First and last name"
          value={about.name}
        />
      </label>
      <label className="block space-y-2">
        <span className="font-medium">What you do</span>
        <Input
          data-testid="onboarding-about-work"
          onChange={patch('work')}
          placeholder="Your job, or what you study"
          value={about.work}
        />
      </label>
      <label className="block space-y-2">
        <span className="font-medium">How your bots should talk to you</span>
        <Textarea
          data-testid="onboarding-about-preferences"
          onChange={patch('preferences')}
          placeholder="Tone, length, language, anything a bot should keep in mind"
          rows={3}
          value={about.preferences}
        />
        <span className="flex justify-between gap-3 text-[length:var(--text-meta)] text-muted">
          <span>You can change all of this later in Settings, Memory.</span>
          <span className={cn('shrink-0', text.length > ABOUT_CAP && 'text-danger')}>
            {text.length} / {ABOUT_CAP}
          </span>
        </span>
      </label>
      <SetupActions className="pt-3">
        <Button
          busy={busy}
          className={PILL}
          data-testid="onboarding-about-continue"
          disabled={!about.name.trim() || text.length > ABOUT_CAP}
          onClick={() => void save(text, about.name.trim())}
          variant="primary"
        >
          Continue
        </Button>
        <Button
          className={PILL}
          data-testid="onboarding-about-skip"
          disabled={busy}
          onClick={() => void save('')}
          variant="secondary"
        >
          Skip
        </Button>
      </SetupActions>
    </div>
  )
}

function DefaultsStep({
  configured,
  onContinue,
  onError
}: {
  configured: Provider[]
  onContinue: (defaultModel: string | null) => void
  onError: (message: string) => void
}) {
  const [choices, setChoices] = useState<ModelChoice[] | null>(null)
  const [defaultModel, setDefaultModel] = useState<string>('')
  const [fallback, setFallback] = useState<string>('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void Promise.all([loadModelChoices(configured), settingsGet().catch(() => null)]).then(
      ([models, settings]) => {
        setChoices(models)
        setDefaultModel(settings?.default_model ?? models[0]?.value ?? '')
        setFallback(settings?.fallback_model ?? '')
      }
    )
  }, [configured])

  const save = async () => {
    setBusy(true)

    try {
      await settingsSet({ default_model: defaultModel || null, fallback_model: fallback || null })
      onContinue(defaultModel || null)
    } catch (reason) {
      onError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  const fallbackChoices = (choices ?? []).filter(item => item.value !== defaultModel)

  return (
    <div className="w-full space-y-5 py-8">
      <label className="block space-y-2">
        <span className="font-medium">Default model</span>
        <span className="block text-secondary text-muted">
          Pre-filled when you create a bot. Each bot can still use its own.
        </span>
        <Select
          label="Default model"
          onValueChange={setDefaultModel}
          options={choices ?? []}
          placeholder={choices ? 'Choose a model' : 'Loading models…'}
          value={defaultModel || undefined}
        />
      </label>
      <label className="block space-y-2">
        <span className="font-medium">
          Fallback <span className="text-muted">(optional)</span>
        </span>
        <span className="block text-secondary text-muted">
          Used when a bot's own provider is down or rate limited.
        </span>
        <Select
          label="Fallback model"
          onValueChange={value => setFallback(value === '__none__' ? '' : value)}
          options={[{ label: 'None', value: '__none__' }, ...fallbackChoices]}
          placeholder="None"
          value={fallback || '__none__'}
        />
      </label>
      <SetupActions className="pt-3">
        <Button
          busy={busy}
          className={PILL}
          data-testid="onboarding-defaults-continue"
          disabled={!defaultModel}
          onClick={() => void save()}
          variant="primary"
        >
          Continue
        </Button>
        <Button
          className={PILL}
          data-testid="onboarding-defaults-skip"
          onClick={() => onContinue(null)}
          variant="secondary"
        >
          Skip
        </Button>
      </SetupActions>
    </div>
  )
}

/**
 * Anonymous usage data, asked once before anything is sent. Off until the
 * switch is turned on; each flip is saved at once, so Continue never decides
 * for the user. In the app it covers the app and its daemon; in a browser,
 * the daemon. Skipped when neither can send it (an older daemon in a browser).
 */
export function UsageStep({
  onContinue,
  onError
}: {
  onContinue: () => void
  onError: (message: string) => void
}) {
  const bridge = getBridge()
  const app = Boolean(bridge?.setUsageData)
  const [daemon, setDaemon] = useState<boolean | null>(null)
  const [on, setOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const skipped = useRef(false)

  useEffect(() => {
    void settingsGet().then(
      settings => setDaemon(settings.usage_data !== undefined),
      () => setDaemon(false)
    )
  }, [])

  useEffect(() => {
    if (daemon === false && !app && !skipped.current) {
      skipped.current = true
      onContinue()
    }
  }, [app, daemon, onContinue])

  const toggle = async (checked: boolean) => {
    setBusy(true)

    try {
      if (daemon) {
        await settingsSet({ usage_data: checked })
      }

      await bridge?.setUsageData?.(checked)
      setOn(checked)
    } catch (reason) {
      onError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="w-full space-y-5 py-8">
      <div className="flex items-center gap-4 rounded-[14px] border border-border bg-surface px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium">Share anonymous usage data</p>
          <p className="text-secondary text-muted">
            {app && daemon
              ? 'From this app and its daemon.'
              : app
                ? 'From this app.'
                : 'From this daemon.'}
          </p>
        </div>
        <Switch
          aria-label="Share anonymous usage data"
          checked={on}
          disabled={busy || daemon === null}
          onCheckedChange={checked => void toggle(checked)}
        />
      </div>
      <UsageDataSummary />
      <p className="text-secondary text-muted">
        You can change this any time in Settings, Privacy.
      </p>
      <SetupActions className="pt-3">
        <Button
          className={PILL}
          data-testid="onboarding-usage-continue"
          disabled={busy}
          onClick={onContinue}
          variant="primary"
        >
          Continue
        </Button>
      </SetupActions>
    </div>
  )
}

/** Set up one tool: pick a provider, paste its key, save and test. */
function ToolPanel({
  connector,
  onSaved
}: {
  connector: Connector
  onSaved: (connector: Connector) => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [provider, setProvider] = useState(connector.provider ?? connector.providers?.[0]?.id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sending = connectorValues(connector, provider, values)

  const save = async () => {
    setBusy(true)
    setError(null)

    try {
      const result = await connectorsSetup({
        id: connector.id,
        ...(provider ? { provider } : {}),
        values: sending
      })

      onSaved(result.connector)

      if (result.test.ok) {
        setValues({})
      } else {
        setError(result.test.message)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={event => {
        event.preventDefault()
        void save()
      }}
    >
      <ConnectorFields
        connector={connector}
        invalid={Boolean(error)}
        onProviderChange={setProvider}
        onValuesChange={setValues}
        provider={provider}
        values={values}
      />
      {error ? (
        <p className="text-secondary text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <Button
        busy={busy}
        className="justify-self-end"
        data-testid={`onboarding-tool-save-${connector.id}`}
        disabled={Object.keys(sending).length === 0}
        type="submit"
        variant="primary"
      >
        Save and test
      </Button>
    </form>
  )
}

/** The tools that need an account: a bot can only use the ones set up here. */
const SETUP_TOOL_GROUPS = new Set(['media', 'search'])

export function ToolsStep({
  onContinue,
  onError
}: {
  onContinue: () => void
  onError: (message: string) => void
}) {
  const [tools, setTools] = useState<Connector[] | null>(null)
  const [selected, setSelected] = useState<string | null>('web_search')

  useEffect(() => {
    connectorsList()
      .then(result => setTools(result.connectors.filter(item => SETUP_TOOL_GROUPS.has(item.group))))
      .catch(reason => onError(String(reason)))
  }, [onError])

  const ready = (tools ?? []).filter(item => item.state === 'ready')

  return (
    <div className="w-full space-y-4 py-8">
      <ul className="max-h-[52vh] divide-y divide-border overflow-y-auto rounded-panel border border-border">
        {(tools ?? []).map(item => {
          const open = selected === item.id

          return (
            <li key={item.id}>
              <button
                aria-expanded={open}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent',
                  open && 'bg-surface-2'
                )}
                data-testid={`onboarding-tool-item-${item.id}`}
                onClick={() => setSelected(open ? null : item.id)}
                type="button"
              >
                <ConnectorIcon icon={item.icon} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{item.name}</span>
                  <span className="block text-secondary text-muted">{item.description}</span>
                </span>
                <Chip tone={item.state === 'ready' ? 'success' : 'neutral'}>{item.state_text}</Chip>
              </button>
              {open ? (
                <div className="border-t border-border bg-background px-4 py-4">
                  <ToolPanel
                    connector={item}
                    onSaved={saved =>
                      setTools(current =>
                        (current ?? []).map(tool => (tool.id === saved.id ? saved : tool))
                      )
                    }
                  />
                </div>
              ) : null}
            </li>
          )
        })}
        {tools === null ? (
          <li className="px-4 py-6 text-center text-secondary text-muted">Loading tools</li>
        ) : null}
      </ul>
      <p className="text-center text-secondary text-muted">
        {ready.length === 0
          ? "Bots cannot use a tool until it is set up. You can do it later in a bot's Connectors."
          : `${ready.length} set up. Add more now, or later in a bot's Connectors.`}
      </p>
      <SetupActions>
        <Button
          className={PILL}
          data-testid="onboarding-tools-continue"
          onClick={onContinue}
          variant={ready.length ? 'primary' : 'secondary'}
        >
          {ready.length ? 'Continue' : 'Skip for now'}
        </Button>
      </SetupActions>
    </div>
  )
}

function OnboardingPage() {
  const navigate = useNavigate()
  const { startSelection } = useChatSelection()
  const connected = useConnection(state => state.status === 'connected')
  const hasBots = useBots(state => state.order.length > 0)

  const [step, setStep] = useState<OnboardingStep>('welcome')
  const [progress, setProgress] = useState<DaemonProgress[]>([])
  const [configured, setConfigured] = useState<Provider[]>([])
  const [defaultModel, setDefaultModel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const creatingPrimary = useRef(false)
  // The bots of someone whose chat did not open, and why, for Continue.
  const [unopened, setUnopened] = useState<{ bots: Bot[]; error: null | string } | null>(null)
  const onError = useCallback((message: string) => setError(message), [])

  // Onboarding ends by creating HexBot, the primary bot, on the chosen
  // default model, and opening its chat, where it introduces itself.
  // A later selection, navigation or daemon wins over a creation still running.
  const createPrimary = async () => {
    if (creatingPrimary.current) {
      return
    }

    creatingPrimary.current = true
    const current = startSelection()
    setCreating(true)

    try {
      const face = styleForName('hexbot')
      const avatar = await avatarPng(face)

      if (current()) {
        const { bot, section } = await createHexBot(defaultModel, avatar, face)

        if (current()) {
          const last = { bot: bot.name, section: section.id }
          uiActions().setLastSection(last)
          void navigate({ to: '/b/$bot/s/$section', params: last })
          void introduceBot(section, bot)

          return
        }
      }
    } catch (reason) {
      if (current()) {
        setError(String(reason))
      }
    } finally {
      creatingPrimary.current = false
    }

    setCreating(false)
  }

  const finish = useCallback(
    async (bots: Bot[], current = startSelection()) => {
      if (!current()) {
        return
      }

      try {
        const last = await landingSection(bots, current)

        if (!current()) {
          return
        }

        if (last) {
          uiActions().setLastSection(last)
          void navigate({ to: '/b/$bot/s/$section', params: last })
        } else if (bots.length) {
          // An older daemon asked which section to continue and none was
          // picked: that opens nothing, and these bots are still here.
          setUnopened({ bots, error: null })
          setStep('continue')
        } else {
          setStep('providers')
        }
      } catch (reason) {
        if (current()) {
          setUnopened({ bots, error: String(reason) })
          setStep('continue')
        }
      }
    },
    [navigate, startSelection]
  )

  // One decision per visit, taken once the daemon is connected and never
  // revisited when the bot list refreshes: the init page when About you was
  // never written (its Skip writes an empty text, so the form only mounts
  // once the read says the file is absent), then the user's section, or
  // provider setup when there are no bots yet.
  const decided = useRef<null | (() => boolean)>(null)
  const decisionComplete = useRef(false)
  const afterAbout = useRef<() => void>(() => setStep('providers'))

  const decide = useCallback(() => {
    if (decisionComplete.current || decided.current?.()) {
      return
    }

    const current = startSelection({ hydrate: true })
    decided.current = current
    setStep('deciding')
    void Promise.all([userMemoryGet(), botsList()])
      .then(([memory, list]) => {
        if (!current()) {
          return
        }

        decisionComplete.current = true

        if (memory.updated_at === null) {
          afterAbout.current = () => void finish(list.bots, current)
          setStep('about')
        } else {
          void finish(list.bots, current)
        }
      })
      .catch(reason => {
        if (current()) {
          decided.current = null
          setError(String(reason))
          setStep('providers')
        }
      })
  }, [finish, startSelection])

  // Decided when the button is pressed, not when the page mounts, so a daemon
  // that connected while the welcome screen was up is taken into account.
  const start = () => {
    const next = initialOnboardingStep({
      connected,
      hasLocalRuntime: hasLocalRuntime(),
      isElectron: isElectron()
    })

    if (next === 'deciding') {
      decide()
    } else {
      setStep(next)
    }
  }

  // An install that already has bots never sees the tour.
  useEffect(() => {
    if (connected && hasBots) {
      decide()
    }
  }, [connected, decide, hasBots])

  useEffect(() => {
    if ((step === 'choice' || step === 'connect' || step === 'install') && connected) {
      decide()
    }
  }, [connected, decide, step])

  useEffect(() => {
    if (step === 'connect') {
      void navigate({ to: '/connect' })
    }
  }, [navigate, step])

  useEffect(() => {
    if (step !== 'install') {
      return
    }

    const bridge = getBridge()

    if (!bridge) {
      return
    }

    const off = bridge.daemon.onProgress(item => setProgress(items => [...items, item]))
    // `start()` resolves once the daemon is spawned, not once it listens, and
    // the supervisor retries on its own; the `connected` effect above moves on.
    void bridge.daemon
      .start()
      .then(status => {
        setLocalDaemonPort(status.port)

        return connectTo({ kind: 'local' })
      })
      .catch(reason => setError(String(reason)))

    return off
  }, [step])

  useEffect(() => setError(null), [step])

  if (step === 'deciding' || step === 'connect') {
    return null
  }

  if (step === 'continue') {
    const bot = landingBot(unopened?.bots ?? [])

    return unopened && bot ? (
      <ContinueStep bot={bot} error={unopened.error} onContinue={() => finish(unopened.bots)} />
    ) : null
  }

  if (creating) {
    return (
      <main className="grid min-h-screen place-items-center bg-background text-foreground">
        <div className="hex-rise">
          <div className="flex flex-col items-center gap-5">
            <HexbotMark act="type" className={ACT_ROOM} size={132} />
            <p role="status">Getting HexBot ready</p>
          </div>
        </div>
      </main>
    )
  }

  if (step === 'welcome') {
    return (
      <main className="relative grid min-h-screen place-items-center bg-background px-6 text-foreground">
        <div aria-hidden className="hex-drag absolute inset-x-0 top-0 h-11" />
        <WelcomeStep onStart={() => setStep('meet')} />
      </main>
    )
  }

  if (step === 'meet') {
    return <MeetStep back={() => setStep('welcome')} next={() => setStep('jobs')} />
  }

  if (step === 'jobs') {
    return <JobsStep back={() => setStep('meet')} next={start} />
  }

  if (step === 'choice') {
    return (
      <ChoiceStep
        back={() => setStep('jobs')}
        onConnect={() => void navigate({ to: '/connect' })}
        onLocal={() => setStep('install')}
      />
    )
  }

  if (step === 'install') {
    return <InstallStep error={error} progress={progress} />
  }

  const copy = (
    {
      about: ['Tell your bots about you', 'Every bot you own reads this from the first message.'],
      defaults: [
        'Pick your defaults',
        'The model new bots start with, and where to go when it fails.'
      ],
      providers: ['Connect a provider', 'Sign in with a subscription or paste an API key.'],
      tools: ['Set up tools', 'Web search and the other tools that need their own account.'],
      usage: ['Help improve Hexbot', 'Nothing is sent unless you turn this on.']
    } as const
  )[step]

  return (
    <SetupFrame subtitle={copy[1]} title={copy[0]}>
      {step === 'about' ? <AboutStep onContinue={afterAbout.current} onError={onError} /> : null}

      {step === 'providers' ? (
        <ProvidersStep
          onContinue={list => {
            setConfigured(list)
            setStep('defaults')
          }}
          onError={onError}
        />
      ) : null}

      {step === 'defaults' ? (
        <DefaultsStep
          configured={configured}
          onContinue={model => {
            setDefaultModel(model)
            setStep('tools')
          }}
          onError={onError}
        />
      ) : null}

      {step === 'usage' ? (
        <UsageStep onContinue={() => void createPrimary()} onError={onError} />
      ) : null}

      {step === 'tools' ? (
        <ToolsStep onContinue={() => setStep('usage')} onError={onError} />
      ) : null}

      {error ? (
        <p className="pb-10 text-center text-secondary text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </SetupFrame>
  )
}
