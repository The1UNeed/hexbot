/**
 * Connector helpers shared by the Connectors page and its set-up sheet:
 * which fields belong to the chosen provider, the values worth sending, and
 * a neutral symbol for each catalog icon.
 */

import type { Connector } from '../../lib/types'

/** Neutral SF Symbols for the catalog's icons; brand glyphs stay on the desktop. */
const GLYPHS: Record<string, string> = {
  airtable: 'tablecells',
  elevenlabs: 'waveform',
  'glyph:film': 'film',
  'glyph:globe': 'globe',
  'glyph:image': 'photo',
  'glyph:search': 'magnifyingglass',
  homeassistant: 'house',
  notion: 'doc.text',
  x: 'at'
}

export const connectorGlyph = (icon: string) => GLYPHS[icon] ?? (icon.startsWith('glyph:') ? 'square.grid.2x2' : 'puzzlepiece.extension')

/** Fields that belong to one provider, or to all of them (provider null). */
export function connectorFieldsFor(connector: Connector, provider?: string) {
  return connector.fields.filter(field => !field.provider || !provider || field.provider === provider)
}

/** The values worth sending: trimmed, non-empty, and for the chosen provider. */
export function connectorValues(connector: Connector, provider: string | undefined, values: Record<string, string>) {
  const visible = new Set(connectorFieldsFor(connector, provider).map(field => field.key))

  return Object.fromEntries(
    Object.entries(values)
      .filter(([key]) => visible.has(key))
      .map(([key, value]) => [key, value.trim()])
      .filter(([, value]) => value)
  )
}
