/**
 * Adding a plugin to the table, start to finish in one window: choose what
 * to add, connect it, then choose the bots that get it. A Google or
 * Microsoft account is signed in to here, alone or with several of its
 * connectors in one sign-in, and what it connects becomes columns under its
 * address.
 */

import { ArrowLeft, Check, ChevronRight, Search, TriangleAlert, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { OwnClientForm } from '../../../components/account-connect'
import { AccountSignInPanel } from '../../../components/account-sign-in'
import { Avatar } from '../../../components/ui/avatar'
import { Button } from '../../../components/ui/button'
import { ConnectorIcon } from '../../../components/ui/connector-icon'
import { Dialog } from '../../../components/ui/dialog'
import { skillsSetGlobal } from '../../../lib/api'
import { botFace } from '../../../lib/avatar-builder'
import { cn } from '../../../lib/cn'
import {
  type AccountOffer,
  count,
  labelsOf,
  listed,
  offersOf,
  pluginKey
} from '../../../lib/plugin-access'
import { DEFAULT_SERVER_ICON, DEFAULT_SKILL_ICON } from '../../../lib/plugin-icons'
import { ACCOUNT_NAMES, isDiscord } from '../../../lib/plugin-rows'
import type { AccountSignIn, Bot, Plugin } from '../../../lib/types'
import { useHeight } from '../../../lib/use-height'
import { type AddStep, usePluginAccess } from '../../../stores/plugin-access'
import { usePlugins } from '../../../stores/plugins'
import { ConnectorSetupSheet } from '../../bot-settings/connector-setup'
import { cardClass, errorText } from '../../bot-settings/shared'
import { AddServerForm, AddSkillForm } from '../plugins'

import type { AccessData } from './data'

const STEPS = ['Choose', 'Connect', 'Give to bots'] as const

const stepOf = (step: AddStep) => (step.at === 'pick' ? 0 : step.at === 'give' ? 2 : 1)

const section = 'mt-5 mb-1.5 px-1 text-[length:var(--text-meta)] font-medium text-muted first:mt-0'

const rowClass =
  'hex-focus flex min-h-[56px] w-full items-center gap-3 px-3.5 py-2 text-left transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.04]'

/** Where the window stands, as three steps along its top. */
function Steps({ at }: { at: number }) {
  return (
    <ol aria-label="Steps" className="flex items-center gap-2 text-[length:var(--text-meta)]">
      {STEPS.map((name, index) => (
        <li
          aria-current={index === at ? 'step' : undefined}
          className={cn(
            'flex items-center gap-1.5 transition-colors duration-[var(--hex-motion-panel)]',
            index === at ? 'font-medium text-foreground' : 'text-muted'
          )}
          key={name}
        >
          {index ? (
            <span
              aria-hidden
              className={cn(
                'h-px w-5 transition-colors duration-[var(--hex-motion-panel)]',
                index <= at ? 'bg-foreground/50' : 'bg-foreground/15'
              )}
            />
          ) : null}
          <span
            aria-hidden
            className={cn(
              'grid size-[18px] place-items-center rounded-full text-[10px] font-semibold tabular-nums transition-colors duration-[var(--hex-motion-panel)]',
              index <= at ? 'bg-foreground text-background' : 'bg-foreground/[0.08]'
            )}
          >
            {index < at ? <Check size={11} strokeWidth={3.2} /> : index + 1}
          </span>
          {name}
        </li>
      ))}
    </ol>
  )
}

function Icons({ plugins }: { plugins: Plugin[] }) {
  return (
    <span aria-hidden className="flex shrink-0 -space-x-1.5">
      {plugins.slice(0, 3).map(plugin => (
        <ConnectorIcon
          className="size-8 rounded-[10px] ring-2 ring-[var(--hex-card,var(--hex-background))]"
          icon={plugin.icon}
          key={plugin.id}
        />
      ))}
    </span>
  )
}

/** "Gmail, Google Calendar and 5 more". */
const some = (plugins: Plugin[]) =>
  plugins.length <= 3
    ? listed(plugins.map(plugin => plugin.name))
    : `${plugins
        .slice(0, 2)
        .map(plugin => plugin.name)
        .join(', ')} and ${plugins.length - 2} more`

export function AddPlugin({ data }: { data: AccessData }) {
  const step = usePluginAccess(state => state.adding)

  // Mounted only while open, so every visit starts clean.
  return step ? <AddWindow data={data} step={step} /> : null
}

function AddWindow({ data, step }: { data: AccessData; step: AddStep }) {
  const go = usePluginAccess(state => state.setAdding)
  const setArrived = usePluginAccess(state => state.setArrived)
  const setSheet = usePluginAccess(state => state.setSheet)
  const refresh = usePlugins(state => state.refresh)
  const { bots, columns, give, plugins } = data
  const offers = useMemo(() => offersOf(plugins), [plugins])
  const [measure, height] = useHeight<HTMLDivElement>()
  const [keyed, setKeyed] = useState<null | string>(null)
  const [error, setError] = useState<null | string>(null)
  const close = () => go(null)

  /** Closes the window and lights the columns that just arrived. */
  const show = (keys: string[]) => {
    setArrived(keys)
    close()
  }

  const offer =
    step.at === 'services' || step.at === 'sign-in'
      ? offers.accounts.find(each => each.provider === step.provider)
      : undefined

  const again = step.at === 'sign-in' && step.again

  const title =
    step.at === 'pick'
      ? 'Add a plugin'
      : step.at === 'services'
        ? `${ACCOUNT_NAMES[step.provider]} account`
        : step.at === 'sign-in'
          ? again
            ? 'Sign in again'
            : `Sign in to ${ACCOUNT_NAMES[step.provider]}`
          : step.at === 'server'
            ? 'Add an MCP server'
            : step.at === 'skill'
              ? 'Add a skill'
              : 'Give it to bots'

  const back: AddStep | null =
    step.at === 'services' || step.at === 'server' || step.at === 'skill'
      ? { at: 'pick' }
      : step.at === 'sign-in' && !again
        ? { at: 'services', chosen: step.services, provider: step.provider }
        : null

  const setUp = keyed ? plugins.find(plugin => pluginKey(plugin) === keyed) : undefined

  return (
    <>
      <Dialog
        className="w-[min(540px,94vw)]"
        label={title}
        onOpenChange={open => !open && close()}
        open
        scroll={false}
      >
        <header className="flex shrink-0 items-start gap-2 px-5 pt-5 pb-3">
          {back ? (
            <Button
              aria-label="Back"
              className="-ml-1.5 shrink-0"
              onClick={() => go(back)}
              size="icon"
              variant="ghost"
            >
              <ArrowLeft size={16} />
            </Button>
          ) : null}
          <div className="min-w-0 flex-1 px-1">
            <h2 className="text-[length:var(--text-heading)] font-semibold tracking-[-0.01em]">{title}</h2>
            {again ? null : (
              <div className="mt-2">
                <Steps at={stepOf(step)} />
              </div>
            )}
          </div>
          <Button aria-label="Close" className="-mr-1 shrink-0" onClick={close} size="icon" variant="ghost">
            <X size={16} />
          </Button>
        </header>
        {/* The window grows and shrinks with its step instead of jumping. */}
        <div
          className="min-h-0 overflow-y-auto transition-[height] duration-[var(--hex-motion-panel)] ease-[var(--hex-ease-out)]"
          style={height ? { height } : undefined}
        >
          <div ref={measure}>
            <div className="hex-step px-5 pt-1 pb-5 text-[length:var(--text-secondary)]" key={step.at}>
              {error ? (
                <p className="mb-3 text-danger" role="alert">
                  {error}
                </p>
              ) : null}
              {step.at === 'pick' ? (
                <Pick
                  offers={offers}
                  onAccount={(provider, chosen) => go({ at: 'services', chosen, provider })}
                  onAgain={(provider, services) => go({ again: true, at: 'sign-in', provider, services })}
                  onOpen={plugin => {
                    setError(null)

                    if (isDiscord(plugin)) {
                      close()
                      setSheet(pluginKey(plugin))
                    } else {
                      setKeyed(pluginKey(plugin))
                    }
                  }}
                  onServer={() => go({ at: 'server' })}
                  onShow={plugin => show([pluginKey(plugin)])}
                  onSkill={() => go({ at: 'skill' })}
                  onTurnOn={plugin => {
                    setError(null)
                    void skillsSetGlobal(plugin.id, true)
                      .then(() => refresh())
                      .then(() => show([pluginKey(plugin)]))
                      .catch(cause => setError(errorText(cause)))
                  }}
                  query={step.query ?? ''}
                />
              ) : null}
              {step.at === 'services' && offer ? (
                <Services
                  chosen={step.chosen ?? []}
                  offer={offer}
                  onAgain={services => go({ again: true, at: 'sign-in', provider: step.provider, services })}
                  onContinue={services => go({ again: false, at: 'sign-in', provider: step.provider, services })}
                />
              ) : null}
              {step.at === 'sign-in' && offer ? (
                <SignIn
                  again={step.again}
                  offer={offer}
                  onDone={async login => {
                    // An older daemon connects the first connector and does not say so.
                    const ids = login.connected ?? step.services.slice(0, 1)

                    await refresh()

                    const keys = ids.map(id => `connector:${id}`)

                    if (step.again || !keys.length) {
                      show(keys)
                    } else {
                      go({ at: 'give', keys, note: login.skipped?.length ? login.message : undefined })
                    }
                  }}
                  plugins={plugins}
                  services={step.services}
                />
              ) : null}
              {step.at === 'server' ? (
                <div className={cardClass}>
                  <AddServerForm
                    onDone={name => {
                      if (!name) {
                        go({ at: 'pick' })

                        return
                      }

                      const made = usePlugins
                        .getState()
                        .plugins.find(plugin => plugin.category === 'mcp' && plugin.name === name)

                      go({ at: 'give', everyone: true, keys: made ? [pluginKey(made)] : [] })
                    }}
                  />
                </div>
              ) : null}
              {step.at === 'skill' ? (
                <div className={cardClass}>
                  <AddSkillForm
                    bots={bots}
                    focus={null}
                    onDone={name => go(name ? { at: 'give', everyone: true, keys: [`skill:${name}`] } : { at: 'pick' })}
                  />
                </div>
              ) : null}
              {step.at === 'give' ? (
                <Give
                  bots={bots}
                  everyone={Boolean(step.everyone)}
                  note={step.note}
                  onDone={names => {
                    if (names.length) {
                      give(names, step.keys, true)
                    }

                    show(step.keys)
                  }}
                  plugins={columns.filter(column => step.keys.includes(column.key)).map(column => column.plugin)}
                />
              ) : null}
            </div>
          </div>
        </div>
      </Dialog>
      {setUp?.connector ? (
        <ConnectorSetupSheet
          connector={setUp.connector}
          onClose={() => {
            setKeyed(null)
            void refresh().then(() => {
              const now = usePlugins.getState().plugins.find(plugin => pluginKey(plugin) === keyed)

              // Set up and tested: next, the bots that get it.
              if (now?.ready && now.state !== 'not_set_up') {
                go({ at: 'give', keys: [pluginKey(now)] })
              }
            })
          }}
        />
      ) : null}
    </>
  )
}

/** Everything that can be added, an account first: what most people come for. */
function Pick({
  offers,
  onAccount,
  onAgain,
  onOpen,
  onServer,
  onShow,
  onSkill,
  onTurnOn,
  query: first
}: {
  offers: ReturnType<typeof offersOf>
  onAccount: (provider: AccountOffer['provider'], chosen?: string[]) => void
  onAgain: (provider: AccountOffer['provider'], services: string[]) => void
  onOpen: (plugin: Plugin) => void
  onServer: () => void
  onShow: (plugin: Plugin) => void
  onSkill: () => void
  onTurnOn: (plugin: Plugin) => void
  query: string
}) {
  const [query, setQuery] = useState(first)
  const needle = query.trim().toLowerCase()
  const matches = (plugin: Plugin) => `${plugin.name} ${plugin.description}`.toLowerCase().includes(needle)

  // A search names one connector, so an account's are listed one by one.
  const found = needle
    ? offers.accounts.flatMap(offer =>
        [...offer.open, ...offer.waiting, ...offer.connected].filter(matches).map(plugin => ({ offer, plugin }))
      )
    : []

  const services = offers.services.filter(plugin => !needle || matches(plugin))
  const off = offers.off.filter(plugin => !needle || matches(plugin))
  const server = !needle || 'mcp server'.includes(needle)
  const skill = !needle || 'skill'.includes(needle)
  const nothing = needle && !found.length && !services.length && !off.length && !server && !skill

  return (
    <>
      <label className="relative mb-4 block">
        <Search className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted" size={15} />
        <input
          aria-label="Search what can be added"
          className="h-10 w-full rounded-full bg-surface-2/60 pr-4 pl-10 text-[length:var(--text-body)] transition-colors outline-none placeholder:text-muted hover:bg-surface-2/80 focus-visible:bg-background focus-visible:outline-2 focus-visible:outline-foreground"
          onChange={event => setQuery(event.target.value)}
          placeholder="Gmail, Notion, an MCP server"
          value={query}
        />
      </label>
      {needle ? null : (
        <>
          <p className={section}>Accounts</p>
          <div className={cn(cardClass, 'divide-y divide-foreground/[0.07] overflow-hidden')}>
            {offers.accounts.map(offer => {
              const name = ACCOUNT_NAMES[offer.provider]
              const all = [...offer.connected, ...offer.waiting, ...offer.open]
              const held = offer.connected.length + offer.waiting.length

              return (
                <div key={offer.provider}>
                  <button
                    aria-label={`${name} account`}
                    className={rowClass}
                    onClick={() => onAccount(offer.provider)}
                    type="button"
                  >
                    <Icons plugins={all} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[length:var(--text-body)] font-medium">{name} account</span>
                      <span className="block truncate text-muted">
                        {held
                          ? `${offer.emails.join(', ') || 'Signed in'} · ${held} of ${all.length} connected`
                          : some(all)}
                      </span>
                    </span>
                    <span className="shrink-0 text-muted">
                      {offer.open.length ? (held ? 'Add more' : 'Sign in') : 'All connected'}
                    </span>
                    <ChevronRight aria-hidden className="shrink-0 text-muted" size={15} />
                  </button>
                  {offer.waiting.length ? (
                    <div className="flex flex-wrap items-center gap-2 bg-warning/[0.08] px-3.5 py-2 text-warning">
                      <TriangleAlert className="shrink-0" size={13} />
                      <span className="min-w-[10rem] flex-1">
                        {listed(offer.waiting.map(plugin => plugin.name))} {offer.waiting.length === 1 ? 'needs' : 'need'}{' '}
                        a new sign-in.
                      </span>
                      <Button
                        onClick={() =>
                          onAgain(
                            offer.provider,
                            offer.waiting.map(plugin => plugin.id)
                          )
                        }
                        size="sm"
                      >
                        Sign in again
                      </Button>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </>
      )}
      {found.length ? (
        <>
          <p className={section}>Accounts</p>
          <div className={cn(cardClass, 'divide-y divide-foreground/[0.07] overflow-hidden')}>
            {found.map(({ offer, plugin }) => {
              const connected = offer.connected.includes(plugin)
              const waiting = offer.waiting.includes(plugin)

              return (
                <button
                  className={rowClass}
                  key={plugin.id}
                  onClick={() =>
                    connected
                      ? onShow(plugin)
                      : waiting
                        ? onAgain(offer.provider, [plugin.id])
                        : onAccount(offer.provider, [plugin.id])
                  }
                  type="button"
                >
                  <ConnectorIcon className="size-8 rounded-[10px]" icon={plugin.icon} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[length:var(--text-body)] font-medium">{plugin.name}</span>
                    <span className="block truncate text-muted">{ACCOUNT_NAMES[offer.provider]} account</span>
                  </span>
                  <span className={cn('shrink-0', waiting ? 'text-warning' : 'text-muted')}>
                    {connected ? 'In the table' : waiting ? 'Sign in again' : 'Sign in'}
                  </span>
                  <ChevronRight aria-hidden className="shrink-0 text-muted" size={15} />
                </button>
              )
            })}
          </div>
        </>
      ) : null}
      {services.length ? (
        <>
          <p className={section}>Services</p>
          <div className={cn(cardClass, 'divide-y divide-foreground/[0.07] overflow-hidden')}>
            {services.map(plugin => (
              <button className={rowClass} key={plugin.id} onClick={() => onOpen(plugin)} type="button">
                <ConnectorIcon className="size-8 rounded-[10px]" icon={plugin.icon} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[length:var(--text-body)] font-medium">{plugin.name}</span>
                  <span className="block truncate text-muted">{plugin.description}</span>
                </span>
                <span className="shrink-0 text-muted">Set up</span>
                <ChevronRight aria-hidden className="shrink-0 text-muted" size={15} />
              </button>
            ))}
          </div>
        </>
      ) : null}
      {server || skill ? (
        <>
          <p className={section}>Your own</p>
          <div className={cn(cardClass, 'divide-y divide-foreground/[0.07] overflow-hidden')}>
            {server ? (
              <button className={rowClass} onClick={onServer} type="button">
                <ConnectorIcon className="size-8 rounded-[10px]" icon={DEFAULT_SERVER_ICON} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[length:var(--text-body)] font-medium">MCP server</span>
                  <span className="block truncate text-muted">A command or a URL, with a skill that explains it</span>
                </span>
                <ChevronRight aria-hidden className="shrink-0 text-muted" size={15} />
              </button>
            ) : null}
            {skill ? (
              <button className={rowClass} onClick={onSkill} type="button">
                <ConnectorIcon className="size-8 rounded-[10px]" icon={DEFAULT_SKILL_ICON} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[length:var(--text-body)] font-medium">Skill</span>
                  <span className="block truncate text-muted">Instructions bots follow for a particular job</span>
                </span>
                <ChevronRight aria-hidden className="shrink-0 text-muted" size={15} />
              </button>
            ) : null}
          </div>
        </>
      ) : null}
      {off.length ? (
        <>
          <p className={section}>Off for every bot</p>
          <div className={cn(cardClass, 'divide-y divide-foreground/[0.07] overflow-hidden')}>
            {off.map(plugin => (
              <div className="flex min-h-[52px] items-center gap-3 px-3.5 py-2" key={pluginKey(plugin)}>
                <ConnectorIcon className="size-8 rounded-[10px]" icon={plugin.icon} />
                <span className="min-w-0 flex-1 truncate text-[length:var(--text-body)] font-medium">
                  {plugin.name}
                </span>
                <Button aria-label={`Turn on ${plugin.name}`} onClick={() => onTurnOn(plugin)} size="sm">
                  Turn on
                </Button>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {nothing ? <p className="px-1 py-6 text-center text-muted">Nothing to add matches that.</p> : null}
    </>
  )
}

/** One account's connectors: tick the ones to connect with one sign-in. */
function Services({
  chosen: first,
  offer,
  onAgain,
  onContinue
}: {
  chosen: string[]
  offer: AccountOffer
  onAgain: (services: string[]) => void
  onContinue: (services: string[]) => void
}) {
  const [chosen, setChosen] = useState(() => first.filter(id => offer.open.some(plugin => plugin.id === id)))
  const name = ACCOUNT_NAMES[offer.provider]
  const held = [...offer.connected, ...offer.waiting]
  const all = chosen.length === offer.open.length

  return (
    <>
      <p className="mb-3 px-1 text-muted">
        {offer.open.length
          ? `Tick what your bots should reach. One sign-in connects them all, and ${name} asks you to allow each one.`
          : `Everything ${name} offers is connected.`}
      </p>
      {offer.open.length ? (
        <>
          <div className="mb-1.5 flex items-center justify-between px-1">
            <p className="text-[length:var(--text-meta)] font-medium text-muted">To connect</p>
            <button
              className="hex-focus rounded-[4px] text-[length:var(--text-meta)] text-muted underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => setChosen(all ? [] : offer.open.map(plugin => plugin.id))}
              type="button"
            >
              {all ? 'Untick all' : 'Tick all'}
            </button>
          </div>
          <div className={cn(cardClass, 'divide-y divide-foreground/[0.07] overflow-hidden')}>
            {offer.open.map(plugin => {
              const on = chosen.includes(plugin.id)

              return (
                <label
                  className={cn(rowClass, 'min-h-[52px] cursor-pointer', on && 'bg-foreground/[0.03]')}
                  key={plugin.id}
                >
                  <ConnectorIcon className="size-8 rounded-[10px]" icon={plugin.icon} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[length:var(--text-body)] font-medium">{plugin.name}</span>
                    <span className="block truncate text-muted">{plugin.description}</span>
                  </span>
                  <input
                    aria-label={`Connect ${plugin.name}`}
                    checked={on}
                    className="hex-focus size-[18px] shrink-0 rounded-[5px] accent-[var(--hex-text)]"
                    onChange={event =>
                      setChosen(event.target.checked ? [...chosen, plugin.id] : chosen.filter(id => id !== plugin.id))
                    }
                    type="checkbox"
                  />
                </label>
              )
            })}
          </div>
        </>
      ) : null}
      {held.length ? (
        <>
          <p className={section}>Connected</p>
          <div className={cn(cardClass, 'divide-y divide-foreground/[0.07] overflow-hidden')}>
            {held.map(plugin => {
              const waiting = offer.waiting.includes(plugin)

              return (
                <div className="flex min-h-[48px] items-center gap-3 px-3.5 py-1.5" key={plugin.id}>
                  <ConnectorIcon icon={plugin.icon} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{plugin.name}</span>
                    <span className={cn('block truncate text-[length:var(--text-meta)]', waiting ? 'text-warning' : 'text-muted')}>
                      {waiting ? 'Needs a new sign-in' : (plugin.connector?.account?.email ?? 'Connected')}
                    </span>
                  </span>
                  {waiting ? (
                    <Button onClick={() => onAgain([plugin.id])} size="sm">
                      Sign in again
                    </Button>
                  ) : (
                    <Check aria-label="Connected" className="shrink-0 text-success" size={15} />
                  )}
                </div>
              )
            })}
          </div>
          <p className="mt-2 px-1 text-[length:var(--text-meta)] text-muted">
            Each connector uses one account. Sign in with another address for the ones you tick, and they
            sit in the table under that address. To move a connected one, disconnect it from its
            column&apos;s heading first.
          </p>
        </>
      ) : null}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button
          className="ml-auto"
          disabled={!chosen.length}
          // In the order the list shows them.
          onClick={() => onContinue(offer.open.filter(plugin => chosen.includes(plugin.id)).map(plugin => plugin.id))}
          size="sm"
          variant="primary"
        >
          {chosen.length ? `Continue with ${chosen.length}` : 'Continue'}
        </Button>
      </div>
    </>
  )
}

/** The sign-in itself, for the connectors chosen. */
function SignIn({
  again,
  offer,
  onDone,
  plugins,
  services
}: {
  again: boolean
  offer: AccountOffer
  onDone: (login: AccountSignIn) => Promise<void>
  plugins: Plugin[]
  services: string[]
}) {
  const refresh = usePlugins(state => state.refresh)
  const [error, setError] = useState<null | string>(null)
  const [advanced, setAdvanced] = useState(false)
  const name = ACCOUNT_NAMES[offer.provider]

  // Held from the first render: once connected they leave the lists they were found in.
  const [chosen] = useState(() =>
    services.flatMap(id => plugins.find(plugin => plugin.kind === 'connector' && plugin.id === id) ?? [])
  )

  const first = chosen[0]
  const email = first?.connector?.account?.email

  if (!first) {
    return <p className="text-muted">Nothing here needs a sign-in.</p>
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-1.5">
        {chosen.map(plugin => (
          <span
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-foreground/[0.06] pr-3 pl-1 font-medium"
            key={plugin.id}
          >
            <ConnectorIcon className="size-6 rounded-full" icon={plugin.icon} />
            {plugin.name}
          </span>
        ))}
      </div>
      <p className="px-1 text-muted">
        {again
          ? `${email ? `The sign-in for ${email}` : 'The sign-in'} stopped working. Sign in again and the bots that had ${listed(chosen.map(plugin => plugin.name))} keep ${chosen.length === 1 ? 'it' : 'them'}.`
          : `Sign in with the ${name} account these should use. Hexbot signs in on the daemon, and no bot gets anything yet.`}
      </p>
      <div className={cn(cardClass, 'px-4 py-4')}>
        <AccountSignInPanel
          also={chosen.slice(1).map(plugin => plugin.id)}
          onDone={login => void onDone(login).catch(cause => setError(errorText(cause)))}
          provider={offer.provider}
          service={first.connector!.account!.service}
        />
      </div>
      {error ? (
        <p className="text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {/* For a build without a sign-in of its own, or a workspace that allows only its own apps. */}
      {advanced ? (
        <OwnClientForm connector={first.connector!} onSaved={refresh} />
      ) : (
        <button
          className="hex-focus justify-self-start rounded-[4px] px-1 text-muted underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => setAdvanced(true)}
          type="button"
        >
          Use your own OAuth client
        </button>
      )}
    </div>
  )
}

/** The last step: the bots that get what was just connected, staged like any other change. */
function Give({
  bots,
  everyone,
  note,
  onDone,
  plugins
}: {
  bots: Bot[]
  /** Already on for every bot, as a new server or skill is. */
  everyone: boolean
  note?: string
  onDone: (bots: string[]) => void
  plugins: Plugin[]
}) {
  const labels = useMemo(() => labelsOf(bots), [bots])
  const primary = bots.find(bot => bot.primary)
  const [all, setAll] = useState(false)
  const [chosen, setChosen] = useState<string[]>([])
  const what = listed(plugins.map(plugin => plugin.name)) || 'It'
  const email = plugins[0]?.connector?.account?.email
  const one = plugins.length <= 1

  const groups = [
    ...(primary ? [{ bots: [primary], id: 'primary', name: primary.display_name, text: 'Primary bot' }] : []),
    ...labels.map(each => ({
      bots: each.bots,
      id: `label:${each.label}`,
      name: `${each.label} bots`,
      text: count(each.bots.length, 'bot')
    }))
  ]

  const picked = all ? bots : groups.filter(group => chosen.includes(group.id)).flatMap(group => group.bots)
  const others = bots.filter(bot => !bot.primary && !labels.some(each => each.bots.includes(bot))).length

  const choice = (on: boolean, press: () => void, faces: Bot[], name: string, text: string) => (
    <button
      aria-pressed={on}
      className={cn(
        'hex-focus flex min-h-[52px] w-full items-center gap-3 rounded-[14px] px-3 py-2 text-left transition-[background-color,box-shadow] duration-[var(--hex-motion-fast)]',
        on
          ? 'bg-foreground/[0.07] shadow-[inset_0_0_0_1.5px_var(--hex-text)]'
          : 'shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--hex-text)_12%,transparent)] hover:bg-foreground/[0.04]'
      )}
      key={name}
      onClick={press}
      type="button"
    >
      <span aria-hidden className="flex w-[46px] shrink-0 -space-x-2">
        {faces.slice(0, 2).map(bot => (
          <Avatar
            {...botFace(bot)}
            className="rounded-full ring-2 ring-[var(--hex-card,var(--hex-background))]"
            key={bot.name}
            name={bot.display_name}
            size="sm"
          />
        ))}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[length:var(--text-body)] font-medium">{name}</span>
        <span className="block text-[length:var(--text-meta)] text-muted">{text}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          'grid size-5 shrink-0 place-items-center rounded-full transition-colors duration-[var(--hex-motion-fast)]',
          on ? 'bg-foreground text-background' : 'shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--hex-text)_35%,transparent)]'
        )}
      >
        {on ? <Check className="hex-tick" size={12} strokeWidth={3.2} /> : null}
      </span>
    </button>
  )

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3 rounded-[14px] bg-success/[0.1] px-3.5 py-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-success text-white">
          <Check className="hex-tick" size={15} strokeWidth={3} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">
            {what} {one ? 'is' : 'are'} {everyone ? 'added' : 'connected'}
            {email ? ` as ${email}` : ''}.
          </span>
          <span className="block text-muted">
            {everyone
              ? `${one ? 'It is' : 'They are'} on for every bot, and ${one ? 'is a new column' : 'are new columns'} in the table.`
              : `${one ? 'It is a new column' : 'They are new columns'} in the table. No bot has ${one ? 'it' : 'them'} yet.`}
          </span>
        </span>
      </div>
      {note ? (
        <p className="flex items-start gap-2 px-1 text-warning">
          <TriangleAlert className="mt-0.5 shrink-0" size={13} />
          {note}
        </p>
      ) : null}
      {everyone ? (
        <div className="flex justify-end">
          <Button onClick={() => onDone([])} size="sm" variant="primary">
            Show {one ? 'it' : 'them'} in the table
          </Button>
        </div>
      ) : (
        <>
          <div>
            <p className={section}>Who gets {one ? 'it' : 'them'}?</p>
            <div aria-label="Bots that get it" className="grid gap-1.5 @min-[460px]:grid-cols-2" role="group">
              {choice(all, () => setAll(!all), bots, 'Every bot', count(bots.length, 'bot'))}
              {groups.map(group =>
                choice(
                  all || chosen.includes(group.id),
                  () => {
                    setAll(false)
                    setChosen(
                      chosen.includes(group.id) && !all
                        ? chosen.filter(id => id !== group.id)
                        : [...chosen.filter(id => id !== group.id), group.id]
                    )
                  },
                  group.bots,
                  group.name,
                  group.text
                )
              )}
            </div>
            {others && !all ? (
              <p className="mt-2 px-1 text-[length:var(--text-meta)] text-muted">
                {count(others, 'bot')} with no shared label {others === 1 ? 'has its' : 'have their'} own row in
                the table.
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <p aria-live="polite" className="min-w-[10rem] flex-1 px-1 text-muted" role="status">
              {picked.length ? (
                <>
                  <span className="font-medium text-foreground">
                    {count(picked.length, 'bot')} {picked.length === 1 ? 'gets' : 'get'} {what}.
                  </span>{' '}
                  Nothing changes until you review.
                </>
              ) : (
                'Choose here, or tick boxes in the table later.'
              )}
            </p>
            <Button onClick={() => onDone([])} size="sm" variant="ghost">
              Not now
            </Button>
            <Button
              disabled={!picked.length}
              onClick={() => onDone(picked.map(bot => bot.name))}
              size="sm"
              variant="primary"
            >
              Add to changes
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
