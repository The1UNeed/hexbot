import { ChevronDown, Copy, Eye, EyeOff, KeyRound, Plus, Search } from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useState } from 'react'

import { Button } from '../../components/ui/button'
import { confirm } from '../../components/ui/confirm'
import { Input } from '../../components/ui/input'
import { SkeletonLines } from '../../components/ui/skeleton'
import { Textarea } from '../../components/ui/textarea'
import { type PasswordInput, passwordsReveal } from '../../lib/api'
import { cn } from '../../lib/cn'
import type { PasswordKeyStore, PasswordLogin } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useConnection } from '../../stores/connection'
import { usePasswords } from '../../stores/passwords'
import { errorText, fieldLabel, Group, Heading } from '../bot-settings/shared'

/** A bot as the page names it. */
interface PasswordBot {
  display_name: string
  name: string
}

const STORE_TEXT: Record<Exclude<PasswordKeyStore, null>, string> = {
  file: "The vault's key is in a file on the daemon's computer that only you can read.",
  keychain: "The vault's key is in the keychain of the daemon's computer.",
  locked:
    "Hexbot can't read the vault's key. Unlock the keychain on the daemon's computer, then open this page again.",
  secret_service: "The vault's key is in the keyring of the daemon's computer."
}

/** Who may use a login, in a few words. */
export function loginBotsText(login: PasswordLogin, bots: PasswordBot[]): string {
  if (login.bots === null) {
    return 'Every bot'
  }

  const on = bots.filter(bot => login.bots?.includes(bot.name))

  if (!on.length) {
    return 'No bots'
  }

  if (on.length <= 2) {
    return on.map(bot => bot.display_name).join(' and ')
  }

  return `${on.length} bots`
}

export function PasswordsSettings(): React.JSX.Element {
  const byName = useBots(state => state.byName)
  const order = useBots(state => state.order)

  // The primary bot first, then the others as the chat list orders them.
  const bots = useMemo(
    () =>
      order
        .map(name => byName[name])
        .filter(bot => bot !== undefined)
        .sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)))
        .map(bot => ({ display_name: bot.display_name || bot.name, name: bot.name })),
    [byName, order]
  )

  const logins = usePasswords(state => state.logins)
  const loading = usePasswords(state => state.loading)
  const loadError = usePasswords(state => state.error)
  const store = usePasswords(state => state.store)
  const refresh = usePasswords(state => state.refresh)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<null | string>(null)
  const [adding, setAdding] = useState(false)
  // Load again after any reconnect or a switch to another daemon.
  const target = useConnection(state => state.target)
  const epoch = useConnection(state => state.epoch)
  const connects = useConnection(state => state.connects)
  useEffect(() => {
    void refresh()

    // Events refresh the list only while this page is open.
    return () => usePasswords.setState({ loaded: false })
  }, [refresh, target, epoch, connects])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()

    return logins.filter(
      login =>
        !needle ||
        `${login.title} ${login.site ?? ''} ${login.username}`.toLowerCase().includes(needle)
    )
  }, [logins, query])

  return (
    <>
      <Heading description="Sign-ins your bots use for you. A bot has Hexbot type them into a page and never sees them. They're kept in a KeePass vault on this daemon.">
        Passwords
      </Heading>
      <div className="mb-6 flex gap-2">
        <label className="relative block flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted"
            size={15}
          />
          <Input
            aria-label="Search passwords"
            className="rounded-full pl-9"
            onChange={event => setQuery(event.target.value)}
            placeholder="Search passwords"
            value={query}
          />
        </label>
        <Button icon={<Plus size={16} />} onClick={() => setAdding(true)} variant="primary">
          Add
        </Button>
      </div>
      {loadError && !logins.length ? (
        <p className="mb-4 text-danger" role="alert">
          {loadError}
        </p>
      ) : null}
      {adding ? (
        <Group className="mb-6" title="New password">
          <LoginForm onDone={() => setAdding(false)} />
        </Group>
      ) : null}
      {loading && !logins.length && !loadError ? <SkeletonLines label="Loading passwords" /> : null}
      {logins.length ? (
        <Group footer={store ? STORE_TEXT[store] : undefined}>
          {visible.map(login => (
            <LoginRow
              bots={bots}
              expanded={expanded === login.id}
              key={login.id}
              login={login}
              onExpand={() => setExpanded(expanded === login.id ? null : login.id)}
            />
          ))}
          {!visible.length ? (
            <p className="px-4 py-3 text-[length:var(--text-secondary)] text-muted">
              No password matches that.
            </p>
          ) : null}
        </Group>
      ) : !loading && !loadError && !adding ? (
        <p className="rounded-[14px] bg-foreground/[0.04] px-4 py-6 text-center text-[length:var(--text-secondary)] text-muted">
          No passwords yet. When a bot needs to sign in somewhere, it asks you in its chat. You can
          also add one here.
        </p>
      ) : null}
    </>
  )
}

function LoginRow({
  bots,
  expanded,
  login,
  onExpand
}: {
  bots: PasswordBot[]
  expanded: boolean
  login: PasswordLogin
  onExpand: () => void
}) {
  const [editing, setEditing] = useState(false)

  return (
    <div data-testid={`password-${login.id}`}>
      <button
        aria-expanded={expanded}
        className="flex min-h-[56px] w-full items-center gap-3 px-4 py-2.5 text-left outline-none"
        onClick={onExpand}
        type="button"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-[8px] bg-foreground/[0.07] text-muted">
          <KeyRound aria-hidden size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{login.title}</span>
          <span className="mt-0.5 block truncate text-[length:var(--text-secondary)] text-muted">
            {[login.site, login.username].filter(Boolean).join(' · ') || 'No site'}
          </span>
        </span>
        <span className="shrink-0 text-[length:var(--text-secondary)] text-muted">
          {loginBotsText(login, bots)}
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            'shrink-0 text-muted transition-transform duration-[var(--hex-motion-fast)]',
            expanded && 'rotate-180'
          )}
          size={15}
        />
      </button>
      {expanded ? (
        <div className="hex-fade grid gap-4 px-4 pt-1 pb-4 pl-[60px] text-[length:var(--text-secondary)]">
          {editing ? (
            <LoginForm login={login} onDone={() => setEditing(false)} />
          ) : (
            <LoginDetails bots={bots} login={login} onEdit={() => setEditing(true)} />
          )}
        </div>
      ) : null}
    </div>
  )
}

function LoginDetails({
  bots,
  login,
  onEdit
}: {
  bots: PasswordBot[]
  login: PasswordLogin
  onEdit: () => void
}) {
  const setBots = usePasswords(state => state.setBots)
  const remove = usePasswords(state => state.remove)
  const [secret, setSecret] = useState<null | { code: null | string; password: string }>(null)
  const [error, setError] = useState<null | string>(null)
  const [copied, setCopied] = useState<null | string>(null)

  // One change at a time: each sends the whole list, read from the last answer.
  const [sharing, setSharing] = useState(false)

  const choose = (next: null | string[]) => {
    setError(null)
    setSharing(true)
    void setBots(login.id, next)
      .catch(cause => setError(errorText(cause)))
      .finally(() => setSharing(false))
  }

  const reveal = async () => {
    setError(null)

    try {
      const shown = await passwordsReveal(login.id)
      setSecret({ code: shown.code?.code ?? null, password: shown.password })
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  const copy = async (what: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(what)
      window.setTimeout(() => setCopied(current => (current === what ? null : current)), 1500)
    } catch {
      setError("Couldn't copy. Select it and copy it yourself.")
    }
  }

  const deleteLogin = async () => {
    if (
      !(await confirm({
        detail: 'Your bots can no longer sign in with it. This cannot be undone.',
        title: `Delete the password for ${login.title}?`
      }))
    ) {
      return
    }

    setError(null)
    void remove(login.id).catch(cause => setError(errorText(cause)))
  }

  return (
    <>
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2">
        {login.url ? (
          <>
            <dt className="text-muted">Site</dt>
            <dd className="truncate">{login.url}</dd>
          </>
        ) : null}
        <dt className="text-muted">Username</dt>
        <dd className="flex min-w-0 items-center gap-2">
          <span className="truncate">{login.username || 'None'}</span>
          {login.username ? (
            <CopyButton
              copied={copied === 'username'}
              label="Copy username"
              onCopy={() => void copy('username', login.username)}
            />
          ) : null}
        </dd>
        <dt className="text-muted">Password</dt>
        <dd className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono">{secret ? secret.password : '••••••••'}</span>
          <button
            aria-label={secret ? 'Hide password' : 'Show password'}
            className="hex-focus grid size-6 shrink-0 place-items-center rounded-[6px] text-muted hover:text-foreground"
            onClick={() => (secret ? setSecret(null) : void reveal())}
            type="button"
          >
            {secret ? <EyeOff aria-hidden size={14} /> : <Eye aria-hidden size={14} />}
          </button>
          {secret ? (
            <CopyButton
              copied={copied === 'password'}
              label="Copy password"
              onCopy={() => void copy('password', secret.password)}
            />
          ) : null}
        </dd>
        {login.has_code ? (
          <>
            <dt className="text-muted">One-time code</dt>
            <dd className="font-mono">{secret?.code ?? '••• •••'}</dd>
          </>
        ) : null}
        {login.notes ? (
          <>
            <dt className="text-muted">Notes</dt>
            <dd className="whitespace-pre-wrap">{login.notes}</dd>
          </>
        ) : null}
      </dl>
      {bots.length ? (
        <BotPicker
          bots={bots}
          chosen={login.bots}
          disabled={sharing}
          name={login.title}
          onChange={choose}
        />
      ) : null}
      {error ? (
        <p className="text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={onEdit} size="sm">
          Edit
        </Button>
        <Button onClick={() => void deleteLogin()} size="sm" variant="ghost">
          Delete
        </Button>
      </div>
    </>
  )
}

function CopyButton({
  copied,
  label,
  onCopy
}: {
  copied: boolean
  label: string
  onCopy: () => void
}) {
  return (
    <button
      aria-label={label}
      className="hex-focus inline-flex h-6 shrink-0 items-center gap-1 rounded-[6px] px-1 text-muted hover:text-foreground"
      onClick={onCopy}
      type="button"
    >
      <Copy aria-hidden size={13} />
      {copied ? <span className="text-[length:var(--text-meta)]">Copied</span> : null}
    </button>
  )
}

/**
 * One pill per bot; a filled pill may use the login. `null` is every bot,
 * including ones added later; taking one away from it names the rest.
 */
function BotPicker({
  bots,
  chosen,
  disabled,
  name,
  onChange
}: {
  bots: PasswordBot[]
  chosen: null | string[]
  disabled: boolean
  name: string
  onChange: (bots: null | string[]) => void
}) {
  const every = chosen === null
  const on = (bot: string) => every || Boolean(chosen?.includes(bot))

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-3">
        <span className="text-muted">Bots</span>
        <button
          className="text-[length:var(--text-meta)] text-muted underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
          disabled={disabled}
          onClick={() => onChange(every ? [] : null)}
          type="button"
        >
          {every ? 'Take from every bot' : 'Give to every bot'}
        </button>
      </div>
      <div aria-label={`Bots that use ${name}`} className="flex flex-wrap gap-1.5" role="group">
        {bots.map(bot => (
          <button
            aria-pressed={on(bot.name)}
            className={cn(
              'h-[30px] rounded-full px-3 whitespace-nowrap transition-colors disabled:opacity-50',
              on(bot.name)
                ? 'bg-accent text-accent-fg'
                : 'bg-foreground/[0.07] text-foreground hover:bg-foreground/[0.11]'
            )}
            disabled={disabled}
            key={bot.name}
            onClick={() =>
              onChange(
                on(bot.name)
                  ? bots.map(b => b.name).filter(b => b !== bot.name && on(b))
                  : [...(chosen ?? []), bot.name]
              )
            }
            type="button"
          >
            {bot.display_name}
          </button>
        ))}
      </div>
      {every ? (
        <p className="mt-1.5 text-[length:var(--text-meta)] text-muted">
          Every bot, and bots you add later.
        </p>
      ) : null}
    </div>
  )
}

/** Adds a login, or changes one; a password or code key left empty stays as it was. */
function LoginForm({ login, onDone }: { login?: PasswordLogin; onDone: () => void }) {
  const save = usePasswords(state => state.save)
  const [title, setTitle] = useState(login?.title ?? '')
  const [url, setUrl] = useState(login?.url ?? '')
  const [username, setUsername] = useState(login?.username ?? '')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [dropCode, setDropCode] = useState(false)
  const [notes, setNotes] = useState(login?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const ready = login ? true : Boolean(password && (url.trim() || title.trim()))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)

    const input: PasswordInput = { notes, title, url: url.trim(), username }

    if (login) {
      input.id = login.id
    }

    if (password) {
      input.password = password
    }

    if (code.trim()) {
      input.code = code
    } else if (dropCode) {
      input.code = ''
    }

    try {
      await save(input)
      onDone()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="grid gap-3 p-4" onSubmit={event => void submit(event)}>
      <label>
        <span className={fieldLabel}>Site</span>
        <Input
          autoCapitalize="none"
          inputMode="url"
          onChange={event => setUrl(event.target.value)}
          placeholder="https://app.schoology.com"
          spellCheck={false}
          value={url}
        />
      </label>
      <label>
        <span className={fieldLabel}>Name</span>
        <Input
          onChange={event => setTitle(event.target.value)}
          placeholder="Schoology"
          value={title}
        />
      </label>
      <label>
        <span className={fieldLabel}>Username or email</span>
        <Input
          autoCapitalize="none"
          autoComplete="off"
          onChange={event => setUsername(event.target.value)}
          spellCheck={false}
          value={username}
        />
      </label>
      <label>
        <span className={fieldLabel}>Password</span>
        <Input
          autoComplete="new-password"
          onChange={event => setPassword(event.target.value)}
          placeholder={login ? 'Leave empty to keep it' : undefined}
          type="password"
          value={password}
        />
      </label>
      <label>
        <span className={fieldLabel}>One-time code key (optional)</span>
        <Input
          autoCapitalize="none"
          autoComplete="off"
          disabled={dropCode}
          onChange={event => setCode(event.target.value)}
          placeholder={
            login?.has_code ? 'Leave empty to keep it' : 'The setup key or otpauth:// link'
          }
          spellCheck={false}
          value={code}
        />
        {login?.has_code ? (
          <button
            className="mt-1.5 text-[length:var(--text-meta)] text-muted underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => {
              setDropCode(value => !value)
              setCode('')
            }}
            type="button"
          >
            {dropCode ? 'Keep the one-time code' : 'Remove the one-time code'}
          </button>
        ) : null}
      </label>
      <label>
        <span className={fieldLabel}>Notes</span>
        <Textarea onChange={event => setNotes(event.target.value)} rows={2} value={notes} />
      </label>
      {error ? (
        <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button busy={busy} disabled={!ready || busy} size="sm" type="submit" variant="primary">
          Save
        </Button>
        <Button disabled={busy} onClick={onDone} size="sm" type="button">
          Cancel
        </Button>
      </div>
    </form>
  )
}
