import { useRouter } from '@tanstack/react-router'
import {
  Clock,
  FileText,
  Globe,
  type LucideIcon,
  MessagesSquare,
  Puzzle,
  Settings,
  Sparkles
} from 'lucide-react'
import {
  type AnchorHTMLAttributes,
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState
} from 'react'

import { Avatar, useFaceColor } from '../../components/ui/avatar'
import { sectionsThread } from '../../lib/api'
import { botFace } from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'
import { mimeOf } from '../../lib/media'
import { botHref, faviconOf, linkLabel, splitMentions, type Tag, tagHint, tagOf } from '../../lib/tags'
import { useBot } from '../../stores/bots'
import { usePlugins } from '../../stores/plugins'
import { useRooms } from '../../stores/rooms'
import { knownChat, useSections } from '../../stores/sections'
import { uiActions } from '../../stores/ui'

import type { FileTarget } from './shared-files'

/** What the tags in a message need to know about where it was said. */
export interface TagScopeValue {
  /** Opens a file beside the chat; only a bot's own chat has one to open. */
  onFile?: (file: FileTarget) => void
  /** The bot whose message this is, by handle; null for yours. */
  speaker: null | string
}

const Scope = createContext<TagScopeValue>({ speaker: null })

/** Says whose message the tags below are in, and what can open from it. */
export function TagScope({
  children,
  onFile,
  speaker
}: TagScopeValue & { children: ReactNode }): React.JSX.Element {
  const scope = useMemo(() => ({ onFile, speaker }), [onFile, speaker])

  return <Scope.Provider value={scope}>{children}</Scope.Provider>
}

/** A Markdown tree, as far as the mention pass reads it. */
interface Node {
  children?: Node[]
  type: string
  url?: string
  value?: string
}

/** Text in these is left as written: a link keeps its own target, code its characters. */
const VERBATIM = new Set(['code', 'definition', 'inlineCode', 'link', 'linkReference'])

function mention(node: Node): void {
  if (!node.children) {
    return
  }

  node.children = node.children.flatMap(child => {
    if (child.type !== 'text' || !child.value?.includes('@')) {
      if (!VERBATIM.has(child.type)) {
        mention(child)
      }

      return [child]
    }

    return splitMentions(child.value).map(
      (part): Node =>
        typeof part === 'string'
          ? { type: 'text', value: part }
          : {
              children: [{ type: 'text', value: `@${part.handle}` }],
              type: 'link',
              url: botHref(part.handle)
            }
    )
  })
}

/** The remark pass that reads `@handle` as a link to that bot. */
export function remarkMentions() {
  return (tree: unknown) => mention(tree as Node)
}

/** The plain words of a link's children, which Markdown may have wrapped in marks. */
function wordsOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }

  if (Array.isArray(node)) {
    return node.map(wordsOf).join('')
  }

  if (node && typeof node === 'object' && 'props' in node) {
    return wordsOf((node.props as { children?: ReactNode }).children)
  }

  return ''
}

/** Icons the site would not give; asked once per page, not on every draw. */
const noIcon = new Set<string>()

/** A site's own icon beside its name, or a globe when it has none to give. */
function SiteIcon({ url }: { url: string }) {
  const icon = faviconOf(url)
  const [failed, setFailed] = useState(() => !icon || noIcon.has(icon))

  if (!icon || failed) {
    return <Globe aria-hidden className={glyphClass} />
  }

  return (
    <img
      alt=""
      className={cn(glyphClass, 'rounded-[3px] object-contain')}
      decoding="async"
      loading="lazy"
      onError={() => {
        noIcon.add(icon)
        setFailed(true)
      }}
      referrerPolicy="no-referrer"
      src={icon}
    />
  )
}

/** A glyph that sits in the line like a letter, a touch below the baseline. */
const glyphClass = 'mr-[0.3em] inline-block size-[1.05em] shrink-0 align-[-0.17em]'

/** The words of a tag: underlined in a quiet tint of the text, stronger on hover. */
const wordsClass =
  'underline decoration-current/25 underline-offset-[3px] transition-[text-decoration-color] duration-[var(--hex-motion-fast)] group-hover/tag:decoration-current'

const tagClass =
  'group/tag hex-focus inline cursor-pointer rounded-[4px] text-left text-inherit [font:inherit]'

const GLYPHS: Record<Exclude<Tag['kind'], 'bot' | 'link'>, LucideIcon> = {
  file: FileText,
  jobs: Clock,
  plugin: Puzzle,
  room: MessagesSquare,
  settings: Settings,
  skill: Sparkles
}

/**
 * A bot's name as a tag draws it: its face, then its name in its colour,
 * pulled toward the text so it reads on any bubble. `words` stands in for the
 * name when the message called the bot something else.
 */
export function BotName({
  bot,
  face = true,
  words
}: {
  bot: NonNullable<ReturnType<typeof useBot>>
  /** Off where the bot's face already shows beside the line. */
  face?: boolean
  words?: ReactNode
}): React.JSX.Element {
  const name = bot.display_name || bot.name
  const color = useFaceColor(bot, name)

  return (
    <>
      {face ? (
        <Avatar
          {...botFace(bot)}
          className="mr-[0.3em] inline-flex size-[1.15em] align-[-0.2em]"
          name={name}
          size="xs"
        />
      ) : null}
      <span
        className="font-medium group-hover/tag:underline group-hover/tag:underline-offset-[3px]"
        style={color ? { color: `color-mix(in srgb, ${color} 62%, currentColor)` } : undefined}
      >
        {words ?? name}
      </span>
    </>
  )
}

/**
 * A bot named in a message: its face and its name in its colour. A click
 * opens the private conversation between it and the bot that named it, beside
 * the chat; named by you, or by itself, it opens its chat with you.
 */
export function BotTag({
  children,
  handle,
  speaker
}: {
  /** Other words than the bot's name; `@handle` and nothing show the name. */
  children?: ReactNode
  handle: string
  /** The bot that named it; the message's own when left out. */
  speaker?: null | string
}): React.JSX.Element {
  const scope = useContext(Scope)
  const bot = useBot(handle)
  // No router in a view drawn on its own, such as a test: the tag then opens nothing.
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | undefined
  const from = speaker === undefined ? scope.speaker : speaker
  const words = wordsOf(children).trim()

  if (!bot) {
    return <>{children ?? `@${handle}`}</>
  }

  const name = bot.display_name || bot.name
  const named = !words || words.replace(/^@/, '').toLowerCase() === handle
  const thread = Boolean(from && from !== handle)

  const open = () => {
    if (thread) {
      const speaker = from!

      // The thread belongs to the bot that was asked. The app keeps no list
      // of threads, so the daemon says which way round this one is.
      const there = async (bot: string, peer: string) =>
        (await sectionsThread(bot, peer).catch(() => null))?.section?.id

      void (async () => {
        const asked = await there(handle, speaker)
        const asking = asked ? undefined : await there(speaker, handle)

        uiActions().openThread(
          asking
            ? { bot: speaker, peer: handle, sectionId: asking }
            : { bot: handle, peer: speaker, sectionId: asked }
        )
      })()

      return
    }

    const chat =
      knownChat(handle) ??
      Object.values(useSections.getState().byId).find(
        section =>
          section.bot === handle && !section.peer_bot && !section.purpose && !section.archived_at
      )

    if (chat) {
      void router?.navigate({ params: { bot: handle, section: chat.id }, to: '/b/$bot/s/$section' })
    }
  }

  return (
    <button
      aria-label={thread ? `Open the conversation with ${name}` : `Open ${name}'s chat`}
      className={tagClass}
      data-tag="bot"
      onClick={open}
      title={thread ? `Open the conversation with ${name}` : `Open ${name}'s chat`}
      type="button"
    >
      <BotName bot={bot} words={named ? undefined : children} />
    </button>
  )
}

/**
 * A link in a message. One that names something Hexbot knows is a tag: an
 * icon and underlined words that open it. A web page shows its site's icon
 * and opens in the browser; a file opens beside the chat; a bot, a room, a
 * Settings page, a plugin or a skill opens where it lives. Scheduled jobs
 * have no page in this app, so their tag is only marked. A tag for something
 * that is not there (a bot or a room since deleted) reads as its plain words.
 */
export function MessageLink({
  children,
  href,
  node: _node,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }): React.JSX.Element {
  const scope = useContext(Scope)
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | undefined
  const tag = useMemo(() => tagOf(href), [href])

  // Rooms by id, or by the name a bot knows them by.
  const room = useRooms(state =>
    tag?.kind === 'room'
      ? (state.byId[tag.room] ??
        Object.values(state.byId).find(
          item => item.name.trim().toLowerCase() === tag.room.trim().toLowerCase()
        ))
      : undefined
  )

  if (!tag) {
    return (
      <a
        className="underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
        href={href}
        rel="noreferrer"
        target="_blank"
        {...rest}
      >
        {children}
      </a>
    )
  }

  if (tag.kind === 'bot') {
    return <BotTag handle={tag.handle}>{children}</BotTag>
  }

  if (tag.kind === 'link') {
    return (
      <a
        className={tagClass}
        data-tag="link"
        href={tag.url}
        rel="noreferrer"
        target="_blank"
        title={tag.url}
      >
        <SiteIcon url={tag.url} />
        <span className={wordsClass}>{linkLabel(wordsOf(children), tag.url)}</span>
      </a>
    )
  }

  const open =
    tag.kind === 'file'
      ? scope.onFile &&
        (() => scope.onFile!({ mime: mimeOf(tag.name), name: tag.name, path: tag.path }))
      : tag.kind === 'room'
        ? room && (() => void router?.navigate({ params: { room: room.id }, to: '/r/$room' }))
        : tag.kind === 'jobs'
          ? // This app has no page for scheduled jobs; the phone app opens its own.
            undefined
          : tag.kind === 'settings'
            ? () => void router?.navigate({ params: { tab: tag.page }, to: '/settings/$tab' })
            : () => {
                usePlugins.getState().seek({ kind: tag.kind, name: tag.name })
                void router?.navigate({ params: { tab: 'plugins' }, to: '/settings/$tab' })
              }

  const Glyph = GLYPHS[tag.kind]
  const words = wordsOf(children).trim() ? children : tag.kind === 'file' ? tag.name : href

  // Nothing to open from here: a file outside a bot's own chat, scheduled
  // jobs, a room that is gone.
  if (!open) {
    return tag.kind === 'file' || tag.kind === 'jobs' ? (
      <span data-tag={tag.kind}>
        <Glyph aria-hidden className={glyphClass} />
        {words}
      </span>
    ) : (
      <>{words}</>
    )
  }

  return (
    <button
      className={tagClass}
      data-tag={tag.kind}
      onClick={open}
      title={tagHint(tag)}
      type="button"
    >
      <Glyph aria-hidden className={glyphClass} />
      <span className={wordsClass}>{words}</span>
    </button>
  )
}
