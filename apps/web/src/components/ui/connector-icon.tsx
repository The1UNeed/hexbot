import {
  AtSign,
  BookOpen,
  Bot,
  Bug,
  CalendarCheck,
  ChartPie,
  Clapperboard,
  ClipboardCheck,
  Code,
  FileSpreadsheet,
  FileText,
  FileType,
  Film,
  FlaskConical,
  FolderSearch,
  GitPullRequest,
  Globe,
  Hexagon,
  Image,
  Inbox,
  LayoutTemplate,
  ListChecks,
  type LucideIcon,
  Mail,
  Monitor,
  Music,
  Network,
  Newspaper,
  Notebook,
  Package,
  Palette,
  PenLine,
  Presentation,
  Quote,
  ScanSearch,
  Scissors,
  Search,
  Server,
  ServerCog,
  ShieldAlert,
  Sparkles,
  SquareTerminal,
  Tag,
  Users,
  Wand,
  Wrench
} from 'lucide-react'

import { cn } from '../../lib/cn'
import { BRAND_ICONS } from '../../lib/connector-icons'

const GLYPHS: Record<string, LucideIcon> = {
  'at-sign': AtSign,
  'book-open': BookOpen,
  bot: Bot,
  bug: Bug,
  'calendar-check': CalendarCheck,
  'chart-pie': ChartPie,
  clapperboard: Clapperboard,
  'clipboard-check': ClipboardCheck,
  code: Code,
  'file-spreadsheet': FileSpreadsheet,
  'file-text': FileText,
  'file-type': FileType,
  film: Film,
  flask: FlaskConical,
  'folder-search': FolderSearch,
  'git-pull-request': GitPullRequest,
  globe: Globe,
  hexagon: Hexagon,
  image: Image,
  inbox: Inbox,
  'layout-template': LayoutTemplate,
  'list-checks': ListChecks,
  mail: Mail,
  monitor: Monitor,
  music: Music,
  network: Network,
  newspaper: Newspaper,
  notebook: Notebook,
  package: Package,
  palette: Palette,
  'pen-line': PenLine,
  presentation: Presentation,
  quote: Quote,
  'scan-search': ScanSearch,
  scissors: Scissors,
  search: Search,
  server: Server,
  'server-cog': ServerCog,
  'shield-alert': ShieldAlert,
  sparkles: Sparkles,
  'square-terminal': SquareTerminal,
  tag: Tag,
  users: Users,
  wand: Wand,
  wrench: Wrench
}

/**
 * A 28px rounded square for a plugin row: the brand glyph in white on the
 * brand colour, or a neutral lucide glyph (`glyph:search`, `glyph:bug`,
 * ...) for rows that front several providers or name no brand.
 */
export function ConnectorIcon({ className, icon }: { className?: string; icon: string }) {
  const brand = BRAND_ICONS[icon]
  const box = 'inline-flex size-7 shrink-0 items-center justify-center rounded-control'

  if (brand) {
    return (
      <span aria-hidden className={cn(box, className)} style={{ backgroundColor: brand.color }}>
        <svg fill="#ffffff" height="16" viewBox="0 0 24 24" width="16">
          <path d={brand.path} />
        </svg>
      </span>
    )
  }

  const Glyph = GLYPHS[icon.replace(/^glyph:/, '')] ?? Server

  return (
    <span aria-hidden className={cn(box, 'bg-surface-3 text-foreground', className)}>
      <Glyph size={16} />
    </span>
  )
}
