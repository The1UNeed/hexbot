/**
 * Generated bot faces: a shape and a colour, drawn as SVG and rasterised to
 * PNG for the profile asset (the daemon accepts png, jpeg or webp only).
 */

export interface AvatarStyle {
  color: string
  shape: string
}

export const AVATAR_SHAPES: { id: string; label: string; path: string }[] = [
  { id: 'round', label: 'Round', path: 'M50 6a44 44 0 1 1 0 88a44 44 0 1 1 0-88Z' },
  {
    id: 'squircle',
    label: 'Squircle',
    path: 'M50 6c33 0 44 11 44 44S83 94 50 94 6 83 6 50 17 6 50 6Z'
  },
  {
    id: 'square',
    label: 'Square',
    path: 'M22 8h56a14 14 0 0 1 14 14v56a14 14 0 0 1-14 14H22A14 14 0 0 1 8 78V22A14 14 0 0 1 22 8Z'
  },
  {
    id: 'blob',
    label: 'Blob',
    path: 'M52 6c24 0 42 16 42 40 0 26-18 48-44 48S6 78 6 52 24 6 52 6Z'
  },
  {
    id: 'triangle',
    label: 'Triangle',
    path: 'M44 12a8 8 0 0 1 12 0l38 66a8 8 0 0 1-6 12H12a8 8 0 0 1-6-12Z'
  },
  {
    id: 'hexagon',
    label: 'Hexagon',
    path: 'M45 6a10 10 0 0 1 10 0l30 17a10 10 0 0 1 5 9v36a10 10 0 0 1-5 9L55 94a10 10 0 0 1-10 0L15 77a10 10 0 0 1-5-9V32a10 10 0 0 1 5-9Z'
  },
  {
    id: 'cloud',
    label: 'Cloud',
    path: 'M30 88a20 20 0 0 1-6-39 24 24 0 0 1 46-10 18 18 0 0 1 24 18 16 16 0 0 1-4 31Z'
  },
  { id: 'drop', label: 'Drop', path: 'M50 6c14 24 40 44 40 62a40 40 0 0 1-80 0C10 50 36 30 50 6Z' }
]

export const AVATAR_COLORS: { id: string; label: string; value: string }[] = [
  { id: 'white', label: 'Chalk', value: '#e8e8ec' },
  { id: 'brown', label: 'Cocoa', value: '#8b5a3c' },
  { id: 'red', label: 'Cherry', value: '#e5484d' },
  { id: 'orange', label: 'Tangerine', value: '#f76b15' },
  { id: 'amber', label: 'Honey', value: '#f5a524' },
  { id: 'green', label: 'Mint', value: '#30a46c' },
  { id: 'teal', label: 'Lagoon', value: '#12a594' },
  { id: 'blue', label: 'Sky', value: '#3e8ef7' },
  { id: 'violet', label: 'Iris', value: '#7c5cf7' },
  { id: 'pink', label: 'Bubblegum', value: '#e93d82' },
  { id: 'gray', label: 'Slate', value: '#8b8d98' }
]

export const DEFAULT_AVATAR_STYLE: AvatarStyle = { color: 'pink', shape: 'round' }

const eyeColor = (color: string) => (color === 'white' ? '#17171a' : '#17171a')

/** The face as an SVG document (100×100 viewBox). */
export function avatarSvg(style: AvatarStyle): string {
  const shape = AVATAR_SHAPES.find(item => item.id === style.shape) ?? AVATAR_SHAPES[0]!
  const color = AVATAR_COLORS.find(item => item.id === style.color) ?? AVATAR_COLORS[0]!
  const eyes = eyeColor(color.id)

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<path d="${shape.path}" fill="${color.value}"/>` +
    `<circle cx="39" cy="54" r="4.5" fill="${eyes}"/>` +
    `<circle cx="61" cy="54" r="4.5" fill="${eyes}"/>` +
    `<path d="M44 66q6 4 12 0" stroke="${eyes}" stroke-width="3" stroke-linecap="round" fill="none"/>` +
    `</svg>`
  )
}

export function avatarSvgDataUrl(style: AvatarStyle): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(avatarSvg(style))}`
}

/** PNG data URL for the profile asset. Resolves to `null` where canvas is unavailable. */
export function avatarPng(style: AvatarStyle, size = 256): Promise<null | string> {
  if (typeof document === 'undefined') {
    return Promise.resolve(null)
  }

  return new Promise(resolve => {
    const image = new Image()

    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const context = canvas.getContext('2d')

      if (!context) {
        resolve(null)

        return
      }

      context.drawImage(image, 0, 0, size, size)

      try {
        resolve(canvas.toDataURL('image/png'))
      } catch {
        resolve(null)
      }
    }

    image.onerror = () => resolve(null)
    image.src = avatarSvgDataUrl(style)
  })
}
