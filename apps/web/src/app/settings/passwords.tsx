import { JsonRpcGatewayError } from '@hermes/shared'
import {
  Braces,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  Search,
  ShieldCheck,
  SquareTerminal,
  Vault
} from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react'

import { Button } from '../../components/ui/button'
import { confirm } from '../../components/ui/confirm'
import { Input } from '../../components/ui/input'
import { Menu } from '../../components/ui/menu'
import { SkeletonLines } from '../../components/ui/skeleton'
import { Switch } from '../../components/ui/switch'
import { Textarea } from '../../components/ui/textarea'
import { type PasswordInput, type PasswordSecret, passwordsReveal } from '../../lib/api'
import { cn } from '../../lib/cn'
import type { PasswordItem, PasswordKeyStore, PasswordKind, PasswordVault } from '../../lib/types'
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

/** With Vaultwarden, the key the page names is its master password. */
const VAULTWARDEN_STORE_TEXT: Record<Exclude<PasswordKeyStore, null>, string> = {
  file: "Your Vaultwarden master password is in a file on the daemon's computer that only you can read.",
  keychain: "Your Vaultwarden master password is in the keychain of the daemon's computer.",
  locked:
    "Hexbot can't read your Vaultwarden master password. Unlock the keychain on the daemon's computer, then open this page again.",
  secret_service: "Your Vaultwarden master password is in the keyring of the daemon's computer."
}

const storeText = (vault: PasswordVault, store: PasswordKeyStore) =>
  store ? (vault.kind === 'vaultwarden' ? VAULTWARDEN_STORE_TEXT : STORE_TEXT)[store] : undefined

const KINDS: Record<
  PasswordKind,
  { icon: typeof KeyRound; label: string; plural: string; title: string }
> = {
  api_key: { icon: Braces, label: 'API key', plural: 'API keys', title: 'New API key' },
  login: { icon: KeyRound, label: 'Login', plural: 'Logins', title: 'New login' },
  ssh_key: { icon: SquareTerminal, label: 'SSH key', plural: 'SSH keys', title: 'New SSH key' }
}

const KIND_ORDER: PasswordKind[] = ['login', 'ssh_key', 'api_key']

/** Older daemons send no kind: every item they have is a login. */
export const kindOf = (item: PasswordItem): PasswordKind => item.kind ?? 'login'

/** The variable an API key goes in when none is given, as the daemon names it. */
export function defaultVariable(title: string): string {
  let name = title
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

  if (!name) {
    return 'API_KEY'
  }

  if (/^\d/.test(name)) {
    name = `_${name}`
  }

  return /(KEY|TOKEN|SECRET)$/.test(name) ? name : `${name}_API_KEY`
}

/** Who may use an item, in a few words. */
export function loginBotsText(login: PasswordItem, bots: PasswordBot[]): string {
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

/** The line under an item's name. */
function subtitle(item: PasswordItem): string {
  switch (kindOf(item)) {
    case 'ssh_key':
      return ['SSH key', item.fingerprint].filter(Boolean).join(' · ')

    case 'api_key':
      return ['API key', item.env].filter(Boolean).join(' · ')

    default:
      return [item.site, item.username].filter(Boolean).join(' · ') || 'No site'
  }
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
  const vault = usePasswords(state => state.vault)
  const refresh = usePasswords(state => state.refresh)
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState<'all' | PasswordKind>('all')
  const [expanded, setExpanded] = useState<null | string>(null)
  const [adding, setAdding] = useState<null | PasswordKind>(null)
  // Load again after any reconnect or a switch to another daemon.
  const target = useConnection(state => state.target)
  const epoch = useConnection(state => state.epoch)
  const connects = useConnection(state => state.connects)
  useEffect(() => {
    void refresh()

    // Events refresh the list only while this page is open.
    return () => usePasswords.setState({ loaded: false })
  }, [refresh, target, epoch, connects])

  const kinds = useMemo(
    () => KIND_ORDER.filter(kind => logins.some(item => kindOf(item) === kind)),
    [logins]
  )

  // A filter for a kind that has gone shows everything again.
  const filter = shown !== 'all' && kinds.includes(shown) ? shown : 'all'

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()

    return logins.filter(
      item =>
        (filter === 'all' || kindOf(item) === filter) &&
        (!needle ||
          [item.title, item.site, item.username, item.env, item.fingerprint]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(needle))
    )
  }, [filter, logins, query])

  return (
    <>
      <Heading
        description={`Sign-ins, SSH keys and API keys your bots use for you. Hexbot types or hands them over for a bot, which never sees them. ${vault.kind === 'vaultwarden' ? "They're kept in your Vaultwarden." : "They're kept in a KeePass vault on this daemon."}`}
      >
        Passwords
      </Heading>
      <div className="mb-4 flex gap-2">
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
        <Menu
          items={KIND_ORDER.map(kind => ({
            'data-testid': `add-${kind}`,
            label: KINDS[kind].label,
            onSelect: () => setAdding(kind)
          }))}
          trigger={
            <Button icon={<Plus size={16} />} variant="primary">
              Add
            </Button>
          }
        />
      </div>
      {kinds.length > 1 ? (
        <div aria-label="Show" className="mb-4 flex flex-wrap gap-1.5" role="group">
          {(['all', ...kinds] as const).map(kind => (
            <button
              aria-pressed={filter === kind}
              className={cn(
                'h-[30px] rounded-full px-3 whitespace-nowrap text-[length:var(--text-secondary)] transition-colors',
                filter === kind
                  ? 'bg-foreground text-background'
                  : 'bg-foreground/[0.07] text-foreground hover:bg-foreground/[0.11]'
              )}
              key={kind}
              onClick={() => setShown(kind)}
              type="button"
            >
              {kind === 'all' ? 'All' : KINDS[kind].plural}
            </button>
          ))}
        </div>
      ) : null}
      {loadError && !logins.length ? (
        <p className="mb-4 text-danger" role="alert">
          {loadError}
        </p>
      ) : null}
      {adding ? (
        <Group className="mb-6" title={KINDS[adding].title}>
          <ItemForm key={adding} kind={adding} onDone={() => setAdding(null)} />
        </Group>
      ) : null}
      {loading && !logins.length && !loadError ? <SkeletonLines label="Loading passwords" /> : null}
      {logins.length ? (
        <Group footer={storeText(vault, store)}>
          {visible.map(login => (
            <ItemRow
              bots={bots}
              expanded={expanded === login.id}
              item={login}
              key={login.id}
              onExpand={() => setExpanded(expanded === login.id ? null : login.id)}
            />
          ))}
          {!visible.length ? (
            <p className="px-4 py-3 text-[length:var(--text-secondary)] text-muted">
              Nothing matches that.
            </p>
          ) : null}
        </Group>
      ) : !loading && !loadError && !adding ? (
        <p className="rounded-[14px] bg-foreground/[0.04] px-4 py-6 text-center text-[length:var(--text-secondary)] text-muted">
          {vault.kind === 'vaultwarden'
            ? "Nothing in your Vaultwarden's Hexbot folder yet. Add logins, SSH keys and API keys here, or move items into that folder in a Bitwarden app."
            : 'No passwords yet. When a bot needs to sign in somewhere or needs an API key, it asks you in its chat. You can also add logins, SSH keys and API keys here.'}
        </p>
      ) : null}
      {loading && !logins.length ? null : <VaultSection count={logins.length} vault={vault} />}
    </>
  )
}

function ItemRow({
  bots,
  expanded,
  item,
  onExpand
}: {
  bots: PasswordBot[]
  expanded: boolean
  item: PasswordItem
  onExpand: () => void
}) {
  const [editing, setEditing] = useState(false)
  const Icon = KINDS[kindOf(item)].icon

  return (
    <div data-testid={`password-${item.id}`}>
      <button
        aria-expanded={expanded}
        className="flex min-h-[56px] w-full items-center gap-3 px-4 py-2.5 text-left outline-none"
        onClick={onExpand}
        type="button"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-[8px] bg-foreground/[0.07] text-muted">
          <Icon aria-hidden size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{item.title}</span>
          <span className="mt-0.5 block truncate text-[length:var(--text-secondary)] text-muted">
            {subtitle(item)}
          </span>
        </span>
        <span className="shrink-0 text-[length:var(--text-secondary)] text-muted">
          {loginBotsText(item, bots)}
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
            <ItemForm item={item} kind={kindOf(item)} onDone={() => setEditing(false)} />
          ) : (
            <ItemDetails bots={bots} item={item} onEdit={() => setEditing(true)} />
          )}
        </div>
      ) : null}
    </div>
  )
}

const DELETE_TEXT: Record<PasswordKind, (title: string) => { detail: string; title: string }> = {
  api_key: title => ({
    detail: 'Your bots can no longer use it. This cannot be undone.',
    title: `Delete the ${title} API key?`
  }),
  login: title => ({
    detail: 'Your bots can no longer sign in with it. This cannot be undone.',
    title: `Delete the password for ${title}?`
  }),
  ssh_key: title => ({
    detail:
      'Your bots can no longer use it. Remove its public key where you added it, too. This cannot be undone.',
    title: `Delete the ${title} SSH key?`
  })
}

function ItemDetails({
  bots,
  item,
  onEdit
}: {
  bots: PasswordBot[]
  item: PasswordItem
  onEdit: () => void
}) {
  const kind = kindOf(item)
  const setBots = usePasswords(state => state.setBots)
  const remove = usePasswords(state => state.remove)
  const [secret, setSecret] = useState<null | PasswordSecret>(null)
  const [codeFor, setCodeFor] = useState(0)

  // A shown one-time code goes when it expires; Show reads a fresh one.
  useEffect(() => {
    if (!codeFor) {
      return
    }

    const timer = window.setTimeout(() => setSecret(null), codeFor * 1000)

    return () => window.clearTimeout(timer)
  }, [codeFor, secret])
  const [error, setError] = useState<null | string>(null)
  const [copied, setCopied] = useState<null | string>(null)

  // One change at a time: each sends the whole list, read from the last answer.
  const [sharing, setSharing] = useState(false)

  const choose = (next: null | string[]) => {
    setError(null)
    setSharing(true)
    void setBots(item.id, next)
      .catch(cause => setError(errorText(cause)))
      .finally(() => setSharing(false))
  }

  const reveal = async () => {
    setError(null)

    try {
      const shown = await passwordsReveal(item.id)
      setSecret(shown)
      setCodeFor(shown.code?.valid_for ?? 0)
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

  const deleteItem = async () => {
    if (!(await confirm(DELETE_TEXT[kind](item.title)))) {
      return
    }

    setError(null)
    void remove(item.id).catch(cause => setError(errorText(cause)))
  }

  /** A secret, hidden until Show; Show reads every secret the item has. */
  const hidden = (label: string, what: string, value: string | undefined, block = false) => (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="flex min-w-0 items-start gap-2">
        {secret && block ? (
          <pre className="max-h-48 min-w-0 flex-1 overflow-auto rounded-[8px] bg-foreground/[0.05] p-2 font-mono text-[length:var(--text-meta)] whitespace-pre-wrap break-all">
            {value}
          </pre>
        ) : (
          <span className="truncate font-mono">{secret ? value : '••••••••'}</span>
        )}
        <button
          aria-label={secret ? `Hide ${what}` : `Show ${what}`}
          className="hex-focus grid size-6 shrink-0 place-items-center rounded-[6px] text-muted hover:text-foreground"
          onClick={() => (secret ? setSecret(null) : void reveal())}
          type="button"
        >
          {secret ? <EyeOff aria-hidden size={14} /> : <Eye aria-hidden size={14} />}
        </button>
        {secret && value ? (
          <CopyButton
            copied={copied === what}
            label={`Copy ${what}`}
            onCopy={() => void copy(what, value)}
          />
        ) : null}
      </dd>
    </>
  )

  const plain = (label: string, what: string, value: string, mono = false): ReactNode => (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="flex min-w-0 items-start gap-2">
        <span className={cn('min-w-0', mono ? 'font-mono break-all' : 'truncate')}>
          {value || 'None'}
        </span>
        {value ? (
          <CopyButton
            copied={copied === what}
            label={`Copy ${what}`}
            onCopy={() => void copy(what, value)}
          />
        ) : null}
      </dd>
    </>
  )

  return (
    <>
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2">
        {item.url ? (
          <>
            <dt className="text-muted">Site</dt>
            <dd className="truncate">{item.url}</dd>
          </>
        ) : null}
        {kind === 'login' ? (
          <>
            {plain('Username', 'username', item.username)}
            {hidden('Password', 'password', secret?.password)}
            {item.has_code ? (
              <>
                <dt className="text-muted">One-time code</dt>
                <dd className="font-mono">{secret?.code?.code ?? '••• •••'}</dd>
              </>
            ) : null}
          </>
        ) : null}
        {kind === 'ssh_key' ? (
          <>
            {plain('Public key', 'public key', item.public_key ?? '', true)}
            {item.fingerprint ? (
              <>
                <dt className="text-muted">Fingerprint</dt>
                <dd className="font-mono break-all">{item.fingerprint}</dd>
              </>
            ) : null}
            {hidden('Private key', 'private key', secret?.private_key, true)}
            {item.has_passphrase ? hidden('Passphrase', 'passphrase', secret?.passphrase) : null}
          </>
        ) : null}
        {kind === 'api_key' ? (
          <>
            {plain('Variable', 'variable', item.env ?? '', true)}
            {hidden('Key', 'key', secret?.key)}
          </>
        ) : null}
        {item.notes ? (
          <>
            <dt className="text-muted">Notes</dt>
            <dd className="whitespace-pre-wrap">{item.notes}</dd>
          </>
        ) : null}
      </dl>
      {kind === 'ssh_key' ? (
        <p className="text-[length:var(--text-meta)] text-muted">
          Add the public key where your bots sign in, such as GitHub's SSH keys page or a server's
          authorized_keys. Bots run ssh and git with the key on their computer and never see it.
        </p>
      ) : null}
      {kind === 'api_key' ? (
        <p className="text-[length:var(--text-meta)] text-muted">
          Bots run commands with it in {item.env || 'its variable'} on their computer and never see
          it.
        </p>
      ) : null}
      {bots.length ? (
        <BotPicker
          bots={bots}
          chosen={item.bots}
          disabled={sharing}
          name={item.title}
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
        <Button onClick={() => void deleteItem()} size="sm" variant="ghost">
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
 * One pill per bot; a filled pill may use the item. `null` is every bot,
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

/**
 * Adds an item of `kind`, or changes `item`. A secret left empty stays as it
 * was: a password or code key, a private key, an API key.
 */
function ItemForm({
  item,
  kind,
  onDone
}: {
  item?: PasswordItem
  kind: PasswordKind
  onDone: () => void
}) {
  const save = usePasswords(state => state.save)
  const [title, setTitle] = useState(item?.title ?? '')
  const [url, setUrl] = useState(item?.url ?? '')
  const [username, setUsername] = useState(item?.username ?? '')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [dropCode, setDropCode] = useState(false)
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  // A new SSH key is made by Hexbot unless the user pastes one.
  const [paste, setPaste] = useState(false)
  const [env, setEnv] = useState(item?.env ?? '')
  const [key, setKey] = useState('')
  const [notes, setNotes] = useState(item?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)

  const ready = (() => {
    if (item) {
      return true
    }

    switch (kind) {
      case 'ssh_key':
        return Boolean(title.trim() && (!paste || privateKey.trim()))

      case 'api_key':
        return Boolean(title.trim() && key.trim())

      default:
        return Boolean(password && (url.trim() || title.trim()))
    }
  })()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)

    const input: PasswordInput = { notes, title }

    if (item) {
      input.id = item.id
    } else if (kind !== 'login') {
      input.kind = kind
    }

    if (kind === 'login') {
      Object.assign(input, { url: url.trim(), username })

      if (password) {
        input.password = password
      }

      if (code.trim()) {
        input.code = code
      } else if (dropCode) {
        input.code = ''
      }
    }

    if (kind === 'ssh_key') {
      // A key typed under Paste, then left for Make a new key, is not sent.
      if ((item || paste) && privateKey.trim()) {
        input.private_key = privateKey
        input.passphrase = passphrase
      } else if (!item) {
        input.generate = true
      }
    }

    if (kind === 'api_key') {
      input.url = url.trim()
      input.env = env.trim()

      if (key.trim()) {
        input.key = key
      }
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
      {kind === 'login' ? (
        <>
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
              placeholder={item ? 'Leave empty to keep it' : undefined}
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
                item?.has_code ? 'Leave empty to keep it' : 'The setup key or otpauth:// link'
              }
              spellCheck={false}
              value={code}
            />
            {item?.has_code ? (
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
        </>
      ) : null}
      {kind === 'ssh_key' ? (
        <>
          <label>
            <span className={fieldLabel}>Name</span>
            <Input
              onChange={event => setTitle(event.target.value)}
              placeholder="GitHub"
              value={title}
            />
          </label>
          {item ? null : (
            <div aria-label="Key" className="flex flex-wrap gap-1.5" role="group">
              {[
                { label: 'Make a new key', value: false },
                { label: 'Paste a key', value: true }
              ].map(option => (
                <button
                  aria-pressed={paste === option.value}
                  className={cn(
                    'h-[30px] rounded-full px-3 whitespace-nowrap text-[length:var(--text-secondary)] transition-colors',
                    paste === option.value
                      ? 'bg-foreground text-background'
                      : 'bg-foreground/[0.07] text-foreground hover:bg-foreground/[0.11]'
                  )}
                  key={option.label}
                  onClick={() => setPaste(option.value)}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
          {item || paste ? (
            <>
              <label>
                <span className={fieldLabel}>
                  {item ? 'Replace the private key' : 'Private key'}
                </span>
                <Textarea
                  autoCapitalize="none"
                  className="font-mono text-[length:var(--text-meta)]"
                  onChange={event => setPrivateKey(event.target.value)}
                  placeholder={
                    item ? 'Leave empty to keep it' : '-----BEGIN OPENSSH PRIVATE KEY-----'
                  }
                  rows={5}
                  spellCheck={false}
                  value={privateKey}
                />
              </label>
              <label>
                <span className={fieldLabel}>Passphrase (if the key has one)</span>
                <Input
                  autoComplete="off"
                  onChange={event => setPassphrase(event.target.value)}
                  type="password"
                  value={passphrase}
                />
              </label>
            </>
          ) : (
            <p className="text-[length:var(--text-secondary)] text-muted">
              Hexbot makes an Ed25519 key and shows you its public key to add where it's needed.
            </p>
          )}
        </>
      ) : null}
      {kind === 'api_key' ? (
        <>
          <label>
            <span className={fieldLabel}>Name</span>
            <Input
              onChange={event => setTitle(event.target.value)}
              placeholder="OpenAI"
              value={title}
            />
          </label>
          <label>
            <span className={fieldLabel}>Key</span>
            <Input
              autoComplete="off"
              onChange={event => setKey(event.target.value)}
              placeholder={item ? 'Leave empty to keep it' : undefined}
              spellCheck={false}
              type="password"
              value={key}
            />
          </label>
          <label>
            <span className={fieldLabel}>Variable</span>
            <Input
              autoCapitalize="characters"
              className="font-mono"
              onChange={event => setEnv(event.target.value)}
              placeholder={defaultVariable(title)}
              spellCheck={false}
              value={env}
            />
          </label>
          <label>
            <span className={fieldLabel}>Site (optional)</span>
            <Input
              autoCapitalize="none"
              inputMode="url"
              onChange={event => setUrl(event.target.value)}
              placeholder="https://platform.openai.com"
              spellCheck={false}
              value={url}
            />
          </label>
        </>
      ) : null}
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

/**
 * Where the items are: the KeePass vault on this daemon, or the Hexbot
 * folder of a Vaultwarden account, which the official Bitwarden CLI on the
 * daemon's computer signs in to.
 */
function VaultSection({ count, vault }: { count: number; vault: PasswordVault }) {
  const connect = usePasswords(state => state.connect)
  const disconnect = usePasswords(state => state.disconnect)
  const [open, setOpen] = useState(false)
  const [server, setServer] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [needsCode, setNeedsCode] = useState(false)
  const [copy, setCopy] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const [notice, setNotice] = useState<null | string>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)

    try {
      const copied = await connect({
        ...(needsCode && code.trim() ? { code: code.trim() } : {}),
        copy: count > 0 && copy,
        email: email.trim(),
        password,
        server: server.trim()
      })

      setPassword('')
      setCode('')
      setNeedsCode(false)
      setOpen(false)
      setNotice(
        copied
          ? `Copied ${copied} ${copied === 1 ? 'item' : 'items'} into the Hexbot folder.`
          : null
      )
    } catch (cause) {
      if (cause instanceof JsonRpcGatewayError && cause.code === 4207) {
        setNeedsCode(true)
      }

      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const leave = async () => {
    if (
      !(await confirm({
        detail:
          'Your bots go back to the passwords saved on this daemon. Nothing in Vaultwarden is deleted.',
        title: 'Disconnect Vaultwarden?'
      }))
    ) {
      return
    }

    setError(null)
    setNotice(null)
    setBusy(true)
    void disconnect()
      .catch(cause => setError(errorText(cause)))
      .finally(() => setBusy(false))
  }

  const status = (
    <>
      {notice ? (
        <p className="px-4 pb-3 text-[length:var(--text-secondary)] text-muted">{notice}</p>
      ) : null}
      {error && !open ? (
        <p className="px-4 pb-3 text-[length:var(--text-secondary)] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </>
  )

  if (vault.kind === 'vaultwarden') {
    return (
      <Group
        className="mt-6"
        footer="Hexbot uses only the items in this account's Hexbot folder. Move an item into it in a Bitwarden app to give it to your bots."
        title="Where they're kept"
      >
        <div className="flex min-h-[56px] items-center gap-3 px-4 py-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-[8px] bg-foreground/[0.07] text-muted">
            <ShieldCheck aria-hidden size={15} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate">Vaultwarden</span>
            <span className="mt-0.5 block truncate text-[length:var(--text-secondary)] text-muted">
              {[vault.email, vault.server.replace(/^https:\/\//, '')].join(' · ')}
            </span>
          </span>
          <Button disabled={busy} onClick={() => void leave()} size="sm">
            Disconnect
          </Button>
        </div>
        {status}
      </Group>
    )
  }

  return (
    <Group
      className="mt-6"
      footer={
        open
          ? "Hexbot signs in with the official Bitwarden CLI, which must be installed on the daemon's computer. It keeps your master password in the daemon's keychain to unlock after a restart, and uses only the items in a Hexbot folder it makes. An account just for your bots is safest."
          : undefined
      }
      title="Where they're kept"
    >
      <div className="flex min-h-[56px] items-center gap-3 px-4 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-[8px] bg-foreground/[0.07] text-muted">
          <Vault aria-hidden size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">This daemon</span>
          <span className="mt-0.5 block truncate text-[length:var(--text-secondary)] text-muted">
            A KeePass vault on the daemon's computer
          </span>
        </span>
        {open ? null : (
          <Button onClick={() => setOpen(true)} size="sm">
            Use Vaultwarden
          </Button>
        )}
      </div>
      {status}
      {open ? (
        <form
          className="grid gap-3 border-t border-foreground/[0.06] p-4"
          onSubmit={event => void submit(event)}
        >
          <label>
            <span className={fieldLabel}>Vaultwarden address</span>
            <Input
              autoCapitalize="none"
              inputMode="url"
              onChange={event => setServer(event.target.value)}
              placeholder="https://vault.example.com"
              spellCheck={false}
              value={server}
            />
          </label>
          <label>
            <span className={fieldLabel}>Email</span>
            <Input
              autoCapitalize="none"
              autoComplete="off"
              inputMode="email"
              onChange={event => setEmail(event.target.value)}
              spellCheck={false}
              value={email}
            />
          </label>
          <label>
            <span className={fieldLabel}>Master password</span>
            <Input
              autoComplete="off"
              onChange={event => setPassword(event.target.value)}
              type="password"
              value={password}
            />
          </label>
          {needsCode ? (
            <label>
              <span className={fieldLabel}>Two-step login code</span>
              <Input
                autoComplete="one-time-code"
                inputMode="numeric"
                onChange={event => setCode(event.target.value)}
                value={code}
              />
            </label>
          ) : null}
          {count ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-[length:var(--text-secondary)]">
                Copy the {count} {count === 1 ? 'item' : 'items'} saved on this daemon
              </span>
              <Switch
                aria-label="Copy the items saved on this daemon"
                checked={copy}
                onCheckedChange={setCopy}
              />
            </div>
          ) : null}
          {error ? (
            <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              busy={busy}
              disabled={
                busy || !server.trim() || !email.trim() || !password || (needsCode && !code.trim())
              }
              size="sm"
              type="submit"
              variant="primary"
            >
              Connect
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setOpen(false)
                setError(null)
              }}
              size="sm"
              type="button"
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </Group>
  )
}
