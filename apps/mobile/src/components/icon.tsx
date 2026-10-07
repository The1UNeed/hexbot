import { SymbolView, type SymbolViewProps } from 'expo-symbols'
import type { ColorValue } from 'react-native'

/**
 * SF Symbols on iOS, Material Symbols on Android. Names are the SF Symbol;
 * `ANDROID` maps the ones the app uses.
 */
const ANDROID: Record<string, string> = {
  'archivebox': 'archive',
  'arrow.clockwise': 'refresh',
  'arrow.triangle.2.circlepath': 'sync',
  'arrow.up': 'arrow_upward',
  'at': 'alternate_email',
  'bell': 'notifications',
  'brain': 'psychology',
  'bubble.left.and.bubble.right': 'forum',
  'camera': 'photo_camera',
  'chart.bar': 'bar_chart',
  'checkmark': 'check',
  'checkmark.circle.fill': 'check_circle',
  'checkmark.shield': 'verified_user',
  'chevron.down': 'expand_more',
  'chevron.left.forwardslash.chevron.right': 'code',
  'chevron.right': 'chevron_right',
  'chevron.up': 'expand_less',
  'circle.lefthalf.filled': 'contrast',
  'cpu': 'memory',
  'desktopcomputer': 'computer',
  'doc': 'description',
  'doc.on.doc': 'content_copy',
  'doc.text': 'article',
  'ellipsis': 'more_horiz',
  'exclamationmark.triangle': 'warning',
  'film': 'movie',
  'gearshape': 'settings',
  'globe': 'language',
  'hand.raised': 'back_hand',
  'house': 'home',
  'info.circle': 'info',
  'iphone': 'smartphone',
  'key': 'key',
  'magnifyingglass': 'search',
  'paperclip': 'attach_file',
  'pencil': 'edit',
  'person.2': 'group',
  'person.text.rectangle': 'badge',
  'photo': 'image',
  'plus': 'add',
  'powerplug': 'power',
  'puzzlepiece.extension': 'extension',
  'qrcode': 'qr_code_2',
  'qrcode.viewfinder': 'qr_code_scanner',
  'questionmark': 'help',
  'quote.bubble': 'format_quote',
  'safari': 'explore',
  'server.rack': 'dns',
  'slider.horizontal.3': 'tune',
  'sparkles': 'auto_awesome',
  'square.and.pencil': 'edit_square',
  'square.fill': 'stop',
  'square.grid.2x2': 'grid_view',
  'stop.fill': 'stop',
  'tablecells': 'table_chart',
  'text.badge.plus': 'playlist_add',
  'trash': 'delete',
  'tray.and.arrow.up': 'unarchive',
  'waveform': 'graphic_eq',
  'wifi': 'wifi',
  'wrench': 'build',
  'wrench.and.screwdriver': 'handyman',
  'xmark': 'close'
}

export interface IconProps {
  color: ColorValue
  name: string
  size?: number
  weight?: 'bold' | 'medium' | 'regular' | 'semibold'
}

export function Icon({ color, name, size = 20, weight = 'regular' }: IconProps) {
  const symbol = { android: ANDROID[name] ?? 'circle', ios: name, web: ANDROID[name] ?? 'circle' } as SymbolViewProps['name']

  return <SymbolView name={symbol} size={size} tintColor={color as string} weight={weight} />
}
