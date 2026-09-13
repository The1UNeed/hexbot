import { Film, Globe, Image, type LucideIcon, Search, Server } from 'lucide-react'

import { cn } from '../../lib/cn'
import { BRAND_ICONS } from '../../lib/connector-icons'

const GLYPHS: Record<string, LucideIcon> = {
  film: Film,
  globe: Globe,
  image: Image,
  search: Search,
  server: Server
}

/**
 * A 28px rounded square for a connector row: the brand glyph in white on
 * the brand colour, or a neutral lucide glyph for rows that front several
 * providers (`glyph:search`, `glyph:image`, ...).
 */
export function ConnectorIcon({ className, icon }: { className?: string; icon: string }) {
  const brand = BRAND_ICONS[icon]
  const box = 'inline-flex size-7 shrink-0 items-center justify-center rounded-control'

  if (brand) {
    return (
      <span
        aria-hidden
        className={cn(box, className)}
        style={{ backgroundColor: brand.color }}
      >
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
