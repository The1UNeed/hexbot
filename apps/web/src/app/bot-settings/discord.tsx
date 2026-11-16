import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { Button, buttonVariants } from '../../components/ui/button'
import { confirm } from '../../components/ui/confirm'
import { ConnectorIcon } from '../../components/ui/connector-icon'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { cn } from '../../lib/cn'
import { DISCORD_MODES, discordModeListens } from '../../lib/discord-modes'
import type { Bot, DiscordMode, DiscordStatus } from '../../lib/types'
import { useDiscord } from '../../stores/discord'
import { usePlugins } from '../../stores/plugins'

import { cardClass, ChoiceRow, dividerClass, errorText, Group, Heading, Row } from './shared'

export const DEVELOPER_PORTAL = 'https://discord.com/developers/applications'

/** The bot's Discord app's state, in words. */
export function discordState(discord: DiscordStatus): string {
  if (discord.status === 'online') {
    return 'Online in Discord'
  }

  if (discord.status === 'error') {
    return discord.error ?? 'Not connected'
  }

  return 'Connecting'
}

/** Settings, Plugins, with Discord in view: where Discord is turned on and off. */
function useOpenPlugins() {
  const navigate = useNavigate()

  return () => {
    usePlugins.getState().seek({ kind: 'plugin', name: 'Discord' })
    void navigate({ params: { tab: 'plugins' }, to: '/settings/$tab' })
  }
}

/** A bot's own Discord app: connect it with a token, add it to servers, see its rooms. */
export function DiscordTab({ bot }: { bot: Bot }) {
  const openPlugins = useOpenPlugins()

  // Discord is turned on for a bot in Plugins. A daemon from before that
  // shows it for every bot.
  if (bot.discord === false) {
    return (
      <div>
        <Heading
          description={`${bot.display_name} can join Discord servers as its own Discord app and talk with people there.`}
        >
          Discord
        </Heading>
        <Group footer="Turn it on in Settings, Plugins, then come back here to connect it.">
          <div className={cardClass}>
            <Row
              control={
                <Button onClick={openPlugins} size="sm" variant="primary">
                  Open Plugins
                </Button>
              }
              description={`Discord is off for ${bot.display_name}.`}
              title={
                <span className="flex items-center gap-2.5">
                  <ConnectorIcon icon="discord" />
                  Discord
                </span>
              }
            />
          </div>
        </Group>
      </div>
    )
  }

  return <DiscordSettings bot={bot} />
}

/** How a bot acts in Discord: its default, and each server's own choice. */
function DiscordModes({ bot, discord }: { bot: Bot; discord: DiscordStatus }) {
  const setMode = useDiscord(state => state.setMode)
  const [error, setError] = useState<null | string>(null)
  const name = bot.display_name
  // A daemon from before modes reads along everywhere and lists no servers.
  const current = discord.mode ?? 'reads'
  const servers = discord.servers ?? []

  const choose = (mode: DiscordMode | null, guildId?: string) => {
    setError(null)
    void setMode(bot.name, mode, guildId).catch(cause => setError(errorText(cause)))
  }

  if (!discord.mode) {
    return null
  }

  const listening =
    discordModeListens(current) || servers.some(server => discordModeListens(server.mode))

  return (
    <>
      <Group
        footer={
          listening
            ? `${name} spends tokens on messages that don't mention it. In a busy server, set a daily token budget for each bot; your primary bot can do it for you.`
            : servers.length
              ? 'Each server can have its own choice below.'
              : undefined
        }
        title={`How ${name} acts in Discord`}
      >
        <div
          aria-label={`How ${name} acts in Discord`}
          className={cn(cardClass, dividerClass)}
          role="radiogroup"
        >
          {DISCORD_MODES.map(mode => (
            <ChoiceRow
              checked={current === mode.value}
              description={mode.description}
              key={mode.value}
              onSelect={() => choose(mode.value)}
              title={mode.label}
            />
          ))}
        </div>
      </Group>
      <Group
        footer={
          servers.length
            ? `To keep ${name} out of a channel, change its permissions in Discord.`
            : `Add ${name} to a server and it shows here.`
        }
        title="Servers"
      >
        {servers.length ? (
          <div className={cn(cardClass, dividerClass)}>
            {servers.map(server => (
              <Row
                control={
                  <div className="w-52">
                    <Select
                      label={`How ${name} acts in ${server.name}`}
                      onValueChange={value =>
                        choose(value === 'default' ? null : (value as DiscordMode), server.id)
                      }
                      options={[
                        { label: 'Same as default', value: 'default' },
                        ...DISCORD_MODES.map(mode => ({ label: mode.label, value: mode.value }))
                      ]}
                      value={server.mode ?? 'default'}
                    />
                  </div>
                }
                key={server.id}
                title={<span className="block truncate">{server.name}</span>}
              />
            ))}
          </div>
        ) : null}
      </Group>
      {error ? (
        <p className="-mt-3 px-1 text-[length:var(--text-secondary)] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </>
  )
}

function DiscordSettings({ bot }: { bot: Bot }) {
  const openPlugins = useOpenPlugins()
  const discord = useDiscord(state => state.byBot[bot.name])
  const loadError = useDiscord(state => state.errors[bot.name])
  const refresh = useDiscord(state => state.refresh)
  const connect = useDiscord(state => state.connect)
  const disconnect = useDiscord(state => state.disconnect)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const name = bot.display_name

  useEffect(() => {
    void refresh(bot.name)
  }, [bot.name, refresh])

  const attempt = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)

    try {
      await action()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const heading = (
    <Heading
      description={`${name} joins Discord servers as its own Discord app and talks with people there. Each channel it talks in becomes a room you can watch here.`}
    >
      Discord
    </Heading>
  )

  if (discord === undefined) {
    return (
      <div>
        {heading}
        <p className="px-1 text-[length:var(--text-secondary)] text-muted" role="status">
          {loadError
            ? /unknown method/i.test(loadError)
              ? 'Update the daemon to connect bots to Discord.'
              : loadError
            : 'Loading'}
        </p>
      </div>
    )
  }

  if (discord === null) {
    const submit = () => {
      if (token.trim()) {
        void attempt(async () => {
          await connect(bot.name, token.trim())
          setToken('')
        })
      }
    }

    return (
      <div>
        {heading}
        <div className="flex flex-col gap-6">
          <Group title="Make a Discord app for this bot">
            <ol className={cn(cardClass, dividerClass)}>
              <Row
                description={
                  <>
                    Choose New Application and name it {name}. Give it {name}&apos;s face as its
                    icon if you like.
                  </>
                }
                title={
                  <>
                    1. Open the{' '}
                    <a
                      className="underline"
                      href={DEVELOPER_PORTAL}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Discord Developer Portal
                    </a>
                  </>
                }
              />
              <Row
                description="Without it the app sees only messages that mention it."
                title="2. Under Bot, turn on Message Content Intent"
              />
              <Row
                description="Still under Bot, choose Reset Token and copy the token."
                title="3. Copy the bot's token"
              />
            </ol>
          </Group>
          <Group
            footer={`Saved on the daemon, where bots' tools can't read it, except in Bypass.`}
            title="Token"
          >
            <form
              className="flex gap-2"
              onSubmit={event => {
                event.preventDefault()
                submit()
              }}
            >
              <Input
                aria-label="Discord bot token"
                autoComplete="off"
                className="flex-1"
                invalid={Boolean(error)}
                onChange={event => setToken(event.target.value)}
                placeholder="Paste the token"
                type="password"
                value={token}
              />
              <Button busy={busy} disabled={!token.trim()} type="submit" variant="primary">
                Connect
              </Button>
            </form>
            {error ? (
              <p className="mt-2 px-1 text-[length:var(--text-secondary)] text-danger" role="alert">
                {error}
              </p>
            ) : null}
          </Group>
        </div>
      </div>
    )
  }

  const rooms = discord.rooms

  return (
    <div>
      {heading}
      <div className="flex flex-col gap-6">
        <Group
          footer={`In Discord, ${name} can only search the web, read the server and keep notes. It never sees About you, and it is told never to share what it knows about you.`}
        >
          <div className={cn(cardClass, dividerClass)}>
            <Row
              control={
                <a
                  className={buttonVariants({ size: 'sm', variant: 'primary' })}
                  href={discord.invite_url}
                  rel="noreferrer"
                  target="_blank"
                >
                  Add to a server
                </a>
              }
              description={
                <span className={discord.status === 'error' ? 'text-danger' : undefined}>
                  {discordState(discord)}
                </span>
              }
              title={
                <span className="flex items-center gap-2.5">
                  <ConnectorIcon icon="discord" />
                  <span className="truncate">{discord.username || name}</span>
                </span>
              }
            />
          </div>
        </Group>
        {discord.status === 'error' ? (
          <Group title="Connect again">
            <form
              className="flex gap-2"
              onSubmit={event => {
                event.preventDefault()

                if (token.trim()) {
                  void attempt(async () => {
                    await connect(bot.name, token.trim())
                    setToken('')
                  })
                }
              }}
            >
              <Input
                aria-label="Discord bot token"
                autoComplete="off"
                className="flex-1"
                onChange={event => setToken(event.target.value)}
                placeholder="Paste the token"
                type="password"
                value={token}
              />
              <Button busy={busy} disabled={!token.trim()} type="submit" variant="primary">
                Connect
              </Button>
            </form>
          </Group>
        ) : null}
        <DiscordModes bot={bot} discord={discord} />
        <Group
          footer={
            rooms.length
              ? undefined
              : discordModeListens(discord.mode)
                ? `Add ${name} to a server. Each channel where someone writes becomes a room here.`
                : `Add ${name} to a server, then @mention it in a channel. That channel becomes a room here.`
          }
          title="Rooms in Discord"
        >
          {rooms.length ? (
            <div className={cn(cardClass, dividerClass)}>
              {rooms.map(room => (
                <Link
                  className="block hover:bg-foreground/[0.03]"
                  key={room.id}
                  params={{ room: room.id }}
                  to="/r/$room"
                >
                  <Row
                    description={room.guild_name ?? undefined}
                    title={`#${room.channel_name ?? 'channel'}`}
                  />
                </Link>
              ))}
            </div>
          ) : null}
        </Group>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            busy={busy}
            onClick={() =>
              void confirm({
                detail: `${name} goes offline in Discord and the token is deleted. Its Discord rooms stay here.`,
                title: `Disconnect ${name} from Discord?`
              }).then(yes => {
                if (yes) {
                  void attempt(() => disconnect(bot.name))
                }
              })
            }
            variant="ghost"
          >
            Disconnect
          </Button>
          <Button onClick={openPlugins} variant="ghost">
            Turn off in Plugins
          </Button>
        </div>
        <div>
          {error ? (
            <p className="mt-2 px-1 text-[length:var(--text-secondary)] text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
