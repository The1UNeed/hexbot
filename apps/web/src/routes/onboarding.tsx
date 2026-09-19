import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArrowRight, ArrowUp, Plus } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'

import { isSubscription, ProviderPanel, supportsApiKey } from '../components/provider-panel'
import { Avatar } from '../components/ui/avatar'
import { AvatarBuilder } from '../components/ui/avatar-builder'
import { Button } from '../components/ui/button'
import { Chip } from '../components/ui/chip'
import type { HexbotActName } from '../components/ui/hexbot-act'
import { Input } from '../components/ui/input'
import { Select } from '../components/ui/select'
import { Textarea } from '../components/ui/textarea'
import { HexbotMark, Wordmark } from '../components/ui/wordmark'
import { botsCreate, modelsList, providersList, settingsGet, settingsSet } from '../lib/api'
import {
  avatarPng,
  type AvatarStyle,
  DEFAULT_AVATAR_STYLE,
  styleForName
} from '../lib/avatar-builder'
import { HANDLE_PATTERN, toHandle } from '../lib/bot-handle'
import { BOT_TEMPLATES } from '../lib/bot-templates'
import { type DaemonProgress, getBridge, hasLocalRuntime, isElectron } from '../lib/bridge'
import { cn } from '../lib/cn'
import { connectTo, setLocalDaemonPort } from '../lib/connection'
import type { Bot, ModelOption, Provider, Section } from '../lib/types'
import { useBots } from '../stores/bots'
import { useConnection } from '../stores/connection'
import { introduceBot } from '../stores/sections'
import { uiActions } from '../stores/ui'

export const Route = createFileRoute('/onboarding')({ component: OnboardingPage })

type OnboardingStep =
  | 'bot'
  | 'choice'
  | 'connect'
  | 'defaults'
  | 'existing'
  | 'install'
  | 'jobs'
  | 'meet'
  | 'providers'
  | 'welcome'

export function initialOnboardingStep(input: {
  connected: boolean
  hasBots: boolean
  hasLocalRuntime: boolean
  isElectron: boolean
}): OnboardingStep {
  if (input.hasBots) {
    return 'existing'
  }

  if (!input.connected && input.isElectron) {
    // The client-only package has nothing to install, so the only way in is
    // to pair with a daemon.
    return input.hasLocalRuntime ? 'choice' : 'connect'
  }

  return 'providers'
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
  { acts: ['catch', 'download', 'fish'], id: 'uv', label: 'Fetching the installer', weight: 5 },
  {
    acts: ['type', 'read', 'tinker'],
    id: 'python',
    label: 'Installing Python',
    weight: 15
  },
  { acts: ['catch', 'download'], id: 'source', label: 'Unpacking Hexbot', weight: 5 },
  {
    acts: ['hammer', 'sweep', 'paint', 'grow'],
    id: 'venv',
    label: 'Preparing the environment',
    weight: 5
  },
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
    label: 'Installing dependencies',
    weight: 55
  },
  { acts: ['inspect', 'read'], id: 'git', label: 'Checking Git', weight: 2 },
  { acts: ['inspect', 'fish'], id: 'ripgrep', label: 'Adding file search', weight: 8 },
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
      modelsList(provider.id)
        .then(result => ({ provider, result }))
        .catch(() => ({ provider, result: { all: [], curated: [] } }))
    )
  )

  return lists.flatMap(({ provider, result }) => {
    const models: ModelOption[] = result.curated.length ? result.curated : result.all

    return models.map(model => ({
      label: `${provider.label} · ${model.label}`,
      value: `${provider.id}/${model.id}`
    }))
  })
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

function BotStep({
  configured,
  defaultModel,
  onBack,
  onCreated,
  onCreating,
  onError
}: {
  configured: Provider[]
  defaultModel: string | null
  onBack: () => void
  onCreated: (bot: Bot, section: Section) => void
  /** The page shows a full-screen "getting ready" state while this is true. */
  onCreating?: (creating: boolean) => void
  onError: (message: string) => void
}) {
  const [style, setStyle] = useState<AvatarStyle>(DEFAULT_AVATAR_STYLE)
  const [displayName, setDisplayName] = useState('')
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [template, setTemplate] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [persona, setPersona] = useState('')

  const [provider, setProvider] = useState(
    () => defaultModel?.split('/')[0] ?? configured[0]?.id ?? ''
  )

  const [models, setModels] = useState<ModelOption[]>([])
  const [model, setModel] = useState(() => defaultModel?.split('/').slice(1).join('/') ?? '')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!provider) {
      return
    }

    void modelsList(provider)
      .then(result => {
        const list = result.curated.length ? result.curated : result.all
        setModels(list)
        setModel(current =>
          list.some(item => item.id === current) ? current : (list[0]?.id ?? '')
        )
      })
      .catch(reason => onError(String(reason)))
  }, [onError, provider])

  const pickTemplate = (id: string) => {
    const item = BOT_TEMPLATES.find(entry => entry.id === id)

    if (!item) {
      return
    }

    setTemplate(id)
    setTitle(item.title)
    setDescription(item.description)
    setPersona(item.persona)
  }

  const valid = HANDLE_PATTERN.test(name) && displayName.trim() && provider && model

  const create = async () => {
    if (!valid) {
      return
    }

    setBusy(true)
    onCreating?.(true)

    try {
      const avatar = await avatarPng(style)

      const result = await botsCreate({
        ...(avatar ? { avatar } : {}),
        description: description.trim(),
        display_name: displayName.trim(),
        model,
        name,
        persona: persona.trim(),
        provider,
        title: title.trim()
      })

      onCreated(result.bot, result.section)
    } catch (reason) {
      onCreating?.(false)
      onError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="w-full space-y-6 py-8">
      <AvatarBuilder onChange={setStyle} value={style} />
      <label className="block space-y-2">
        <span className="font-medium">Name</span>
        <Input
          autoFocus
          className="h-11 text-[length:var(--text-title)] font-semibold"
          data-testid="onboarding-bot-display-input"
          onChange={event => {
            setDisplayName(event.target.value)

            if (!nameEdited) {
              setName(toHandle(event.target.value))
            }
          }}
          placeholder="What should we call it?"
          value={displayName}
        />
        <span className="flex items-center gap-2 text-[length:var(--text-meta)] text-muted">
          Handle
          <input
            aria-label="Bot handle"
            className={cn(
              'min-w-0 flex-1 bg-transparent font-mono outline-none',
              name && !HANDLE_PATTERN.test(name) ? 'text-danger' : 'text-foreground'
            )}
            data-testid="onboarding-bot-name-input"
            onChange={event => {
              setNameEdited(true)
              setName(event.target.value)
            }}
            value={name}
          />
        </span>
      </label>
      <div className="space-y-2">
        <span className="block text-[length:var(--text-meta)] text-muted">Start from a role</span>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {BOT_TEMPLATES.map(item => (
            <button
              aria-pressed={template === item.id}
              className={cn(
                'flex items-center gap-2 rounded-panel border px-3 py-2 text-left transition-colors hover:bg-surface-2',
                template === item.id ? 'border-accent bg-accent/8' : 'border-border'
              )}
              key={item.id}
              onClick={() => pickTemplate(item.id)}
              title={item.description}
              type="button"
            >
              <Avatar name={item.title} size="sm" style={styleForName(item.id)} />
              <span className="min-w-0 truncate font-medium">{item.title}</span>
            </button>
          ))}
        </div>
      </div>
      <details className="group">
        <summary className="cursor-pointer text-secondary text-muted">
          Customise the persona
        </summary>
        <div className="mt-3 space-y-3">
          <Input
            aria-label="Bot title"
            onChange={event => setTitle(event.target.value)}
            placeholder="Title"
            value={title}
          />
          <Input
            aria-label="Bot description"
            onChange={event => setDescription(event.target.value)}
            placeholder="One-line description"
            value={description}
          />
          <Textarea
            aria-label="Persona"
            onChange={event => setPersona(event.target.value)}
            placeholder="How should it think and talk?"
            value={persona}
          />
        </div>
      </details>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-2">
          <span className="font-medium">Provider</span>
          <Select
            label="Provider"
            onValueChange={setProvider}
            options={configured.map(item => ({ label: item.label, value: item.id }))}
            value={provider}
          />
        </label>
        <label className="block space-y-2">
          <span className="font-medium">Model</span>
          <div data-testid="onboarding-model-select">
            <Select
              label="Model"
              onValueChange={setModel}
              options={models.map(item => ({ label: item.label, value: item.id }))}
              placeholder="Choose a model"
              value={model || undefined}
            />
          </div>
        </label>
      </div>
      <SetupActions className="pt-3">
        <span data-testid="onboarding-create">
          <Button
            busy={busy}
            className={PILL}
            data-testid="onboarding-create-button"
            disabled={!valid}
            onClick={() => void create()}
            variant="primary"
          >
            Create bot
          </Button>
        </span>
        <Button className={PILL} onClick={onBack} variant="secondary">
          Back
        </Button>
      </SetupActions>
    </div>
  )
}

function OnboardingPage() {
  const navigate = useNavigate()
  const connected = useConnection(state => state.status === 'connected')
  const order = useBots(state => state.order)
  const byName = useBots(state => state.byName)
  const bots = useMemo(() => order.map(name => byName[name]).filter(Boolean), [byName, order])

  const [step, setStep] = useState<OnboardingStep>('welcome')

  // Decided when the button is pressed, not when the page mounts, so a daemon
  // that connected while the welcome screen was up is taken into account.
  const start = () =>
    setStep(
      initialOnboardingStep({
        connected,
        hasBots: bots.length > 0,
        hasLocalRuntime: hasLocalRuntime(),
        isElectron: isElectron()
      })
    )

  const [progress, setProgress] = useState<DaemonProgress[]>([])
  const [configured, setConfigured] = useState<Provider[]>([])
  const [defaultModel, setDefaultModel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const onError = useCallback((message: string) => setError(message), [])

  useEffect(() => {
    const bot = bots[0]
    const section = bot?.sections_recent[0]

    if (!bot || !section) {
      return
    }

    setStep('existing')
    const last = { bot: bot.name, section: section.id }
    uiActions().setLastSection(last)
    void navigate({ to: '/b/$bot/s/$section', params: last })
  }, [bots, navigate])

  useEffect(() => {
    if ((step === 'choice' || step === 'connect' || step === 'install') && connected) {
      setStep('providers')
    }
  }, [connected, step])

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

  if (step === 'existing' || step === 'connect') {
    return null
  }

  if (creating) {
    return (
      <main className="grid min-h-screen place-items-center bg-background text-foreground">
        <div className="hex-rise">
          <div className="flex flex-col items-center gap-5">
            <HexbotMark act="type" className={ACT_ROOM} size={132} />
            <p role="status">Getting your bot ready</p>
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
      bot: [
        'Meet your first bot',
        'Give it a face, a name and a role. You can change all of it later.'
      ],
      defaults: [
        'Pick your defaults',
        'The model new bots start with, and where to go when it fails.'
      ],
      providers: ['Connect a provider', 'Sign in with a subscription or paste an API key.']
    } as const
  )[step]

  return (
    <SetupFrame subtitle={copy[1]} title={copy[0]}>
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
            setStep('bot')
          }}
          onError={onError}
        />
      ) : null}

      {step === 'bot' ? (
        <BotStep
          configured={configured}
          defaultModel={defaultModel}
          onBack={() => setStep('defaults')}
          onCreated={(bot, section) => {
            const last = { bot: bot.name, section: section.id }
            uiActions().setLastSection(last)
            void navigate({ to: '/b/$bot/s/$section', params: last })
            void introduceBot(section, bot)
          }}
          onCreating={setCreating}
          onError={onError}
        />
      ) : null}

      {error ? (
        <p className="pb-10 text-center text-secondary text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </SetupFrame>
  )
}
