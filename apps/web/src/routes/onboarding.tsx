import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArrowRight, ArrowUp, Check, Plus } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'

import { isSubscription, ProviderPanel, supportsApiKey } from '../components/provider-panel'
import { Face } from '../components/ui/avatar'
import { AvatarBuilder } from '../components/ui/avatar-builder'
import { Button } from '../components/ui/button'
import { Chip } from '../components/ui/chip'
import { Input } from '../components/ui/input'
import { Select } from '../components/ui/select'
import { Spinner } from '../components/ui/spinner'
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
import type { ModelOption, Provider, Section } from '../lib/types'
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

export function OnboardingChoiceCards(props: { onConnect: () => void; onLocal: () => void }) {
  const choices = [
    {
      description: 'Install the runtime on this computer and run bots here.',
      onClick: props.onLocal,
      title: 'Run Hexbot on this machine'
    },
    {
      description: 'Pair with a daemon on your network or a Tailscale address.',
      onClick: props.onConnect,
      title: 'Connect to a Hexbot daemon'
    }
  ]

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {choices.map(choice => (
        <button
          className="rounded-panel border border-border bg-background p-4 text-left outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent"
          key={choice.title}
          onClick={choice.onClick}
          type="button"
        >
          <span className="block font-semibold">{choice.title}</span>
          <span className="mt-1 block text-secondary text-muted">{choice.description}</span>
        </button>
      ))}
    </div>
  )
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
    <main className="relative flex min-h-screen flex-col items-center bg-background px-6 text-foreground">
      <div aria-hidden className="hex-drag absolute inset-x-0 top-0 h-11" />
      <div className="hex-rise flex w-full max-w-[520px] flex-1 flex-col items-center" key={title}>
        <h1 className="pt-[13vh] text-center text-[22px] leading-snug font-medium">{title}</h1>
        <div className="grid w-full flex-1 place-items-center py-8">{children}</div>
        <div className="flex w-56 flex-col gap-2 pb-[12vh]">
          <Button
            className="h-9 w-full rounded-full"
            data-testid="onboarding-next"
            onClick={next}
            variant="primary"
          >
            Next
          </Button>
          {back ? (
            <Button className="h-9 w-full rounded-full" onClick={back} variant="secondary">
              Back
            </Button>
          ) : null}
        </div>
      </div>
    </main>
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
            <span className="hex-face size-16">
              <Face style={job.style} />
            </span>
            <Chip>{job.label}</Chip>
          </div>
        ))}
      </div>
    </TourPage>
  )
}

const STEPS: { id: OnboardingStep; label: string }[] = [
  { id: 'providers', label: 'Providers' },
  { id: 'defaults', label: 'Defaults' },
  { id: 'bot', label: 'First bot' }
]

function Stepper({ current }: { current: OnboardingStep }) {
  const index = STEPS.findIndex(step => step.id === current)

  if (index < 0) {
    return null
  }

  return (
    <ol className="flex items-center justify-center gap-2 text-[length:var(--text-meta)] text-muted">
      {STEPS.map((step, position) => (
        <li className="flex items-center gap-2" key={step.id}>
          <span
            className={cn(
              'grid size-5 place-items-center rounded-full border text-[10px] font-semibold',
              position < index
                ? 'border-accent bg-accent text-accent-fg'
                : position === index
                  ? 'border-accent text-accent'
                  : 'border-border'
            )}
          >
            {position < index ? <Check size={11} /> : position + 1}
          </span>
          <span className={position === index ? 'text-foreground' : undefined}>{step.label}</span>
          {position < STEPS.length - 1 ? <span className="mx-1 h-px w-6 bg-border" /> : null}
        </li>
      ))}
    </ol>
  )
}

function ProvidersStep({
  onContinue,
  onError
}: {
  onContinue: (configured: Provider[]) => void
  onError: (message: string) => void
}) {
  const [providers, setProviders] = useState<Provider[]>([])
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

  const configured = providers.filter(item => item.configured === true)

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()

    return providers.filter(
      item => !query || `${item.label} ${item.id}`.toLowerCase().includes(query)
    )
  }, [providers, search])

  return (
    <div className="space-y-4">
      <Input
        aria-label="Search providers"
        data-testid="onboarding-provider-search"
        onChange={event => setSearch(event.target.value)}
        placeholder="Search providers"
        value={search}
      />
      <ul className="max-h-[46vh] divide-y divide-border overflow-y-auto rounded-panel border border-border">
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
          <li className="px-4 py-6 text-center text-secondary text-muted">No providers match.</li>
        ) : null}
      </ul>
      <div className="flex items-center justify-between">
        <span className="text-secondary text-muted">
          {configured.length === 0
            ? 'Connect at least one provider to continue.'
            : `${configured.length} connected. Add more now, or later in Settings.`}
        </span>
        <Button
          data-testid="onboarding-continue"
          disabled={configured.length === 0}
          onClick={() => onContinue(configured)}
          variant="primary"
        >
          Continue
        </Button>
      </div>
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
    <div className="space-y-5">
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
      <div className="flex justify-end gap-2">
        <Button
          data-testid="onboarding-defaults-skip"
          onClick={() => onContinue(null)}
          variant="ghost"
        >
          Skip
        </Button>
        <Button
          busy={busy}
          data-testid="onboarding-defaults-continue"
          disabled={!defaultModel}
          onClick={() => void save()}
          variant="primary"
        >
          Continue
        </Button>
      </div>
    </div>
  )
}

function BotStep({
  configured,
  defaultModel,
  onCreated,
  onCreating,
  onError
}: {
  configured: Provider[]
  defaultModel: string | null
  onCreated: (bot: string, section: Section, displayName: string) => void
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

      onCreated(result.bot.name, result.section, displayName.trim())
    } catch (reason) {
      onCreating?.(false)
      onError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
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
        <span className="block text-[length:var(--text-meta)] text-muted">Suggestions</span>
        <div className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1">
          {BOT_TEMPLATES.map(item => (
            <button
              aria-pressed={template === item.id}
              className={cn(
                'flex w-[220px] shrink-0 snap-start items-start gap-3 rounded-panel border p-3 text-left transition-colors hover:bg-surface-2',
                template === item.id ? 'border-accent bg-accent/8' : 'border-border'
              )}
              key={item.id}
              onClick={() => pickTemplate(item.id)}
              type="button"
            >
              <span className="hex-face mt-0.5 size-8 shrink-0">
                <Face style={styleForName(item.id)} />
              </span>
              <span className="min-w-0">
                <span className="block font-medium">{item.title}</span>
                <span className="mt-0.5 line-clamp-2 block text-[length:var(--text-meta)] text-muted">
                  {item.description}
                </span>
              </span>
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
      <div className="flex justify-end" data-testid="onboarding-create">
        <Button
          busy={busy}
          data-testid="onboarding-create-button"
          disabled={!valid}
          onClick={() => void create()}
          variant="primary"
        >
          Create bot
        </Button>
      </div>
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
        <div className="hex-rise flex flex-col items-center gap-4" role="status">
          <Spinner label="Creating bot" />
          <p className="text-muted">Getting your bot ready…</p>
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

  const copy = {
    bot: [
      'Meet your first bot',
      'Give it a face, a name and a role. You can change all of it later.'
    ],
    choice: ['Where should Hexbot run?', 'Choose a daemon on another device or install one here.'],
    defaults: [
      'Pick your defaults',
      'The model new bots start with, and where to go when it fails.'
    ],
    install: ['Setting up Hexbot', 'Installing the local runtime and its dependencies.'],
    providers: ['Connect a provider', 'Sign in with a subscription or paste an API key.']
  }[step]

  return (
    <main className="relative flex min-h-screen justify-center bg-background px-6 pt-[10vh] pb-10 text-foreground">
      <div aria-hidden className="hex-drag absolute inset-x-0 top-0 h-11" />
      <section className="hex-rise w-full max-w-[600px] space-y-6" key={step}>
        <Stepper current={step} />
        <header className="text-center">
          <h1 className="text-[22px] leading-snug font-medium">{copy[0]}</h1>
          <p className="mt-1 text-secondary text-muted">{copy[1]}</p>
        </header>

        {step === 'choice' ? (
          <OnboardingChoiceCards
            onConnect={() => void navigate({ to: '/connect' })}
            onLocal={() => setStep('install')}
          />
        ) : null}

        {step === 'install' ? (
          <div>
            <p className="flex items-center gap-2.5 text-muted" role="status">
              <Spinner label="Installing" size="sm" />
              {progress.at(-1)?.message ?? 'Preparing the local runtime…'}
            </p>
            <div className="mt-4 h-1 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-foreground transition-[width] duration-[var(--hex-motion-enter)] ease-[var(--hex-ease-out)]"
                style={{ width: `${Math.round((progress.at(-1)?.fraction ?? 0) * 100)}%` }}
              />
            </div>
            <details className="mt-3 text-secondary text-muted">
              <summary>Install log</summary>
              <pre className="mt-2 whitespace-pre-wrap font-mono text-meta">
                {progress.map(item => item.detail ?? item.message).join('\n')}
              </pre>
            </details>
          </div>
        ) : null}

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
            onCreated={(bot, section, displayName) => {
              const last = { bot, section: section.id }
              uiActions().setLastSection(last)
              void navigate({ to: '/b/$bot/s/$section', params: last })
              void introduceBot(section, displayName)
            }}
            onCreating={setCreating}
            onError={onError}
          />
        ) : null}

        {error ? (
          <p className="text-secondary text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </main>
  )
}
