// A file's kind as its card shows it: a label and the colour of the band on its
// page icon. Shared by the web and mobile apps so a file looks the same on both.

export interface FileKind {
  /** The band across the foot of the page icon. */
  color: string
  label: string
}

const KINDS: [RegExp, FileKind][] = [
  [/^pdf$/, { color: '#E5484D', label: 'PDF' }],
  [/^(docx?|odt|rtf|pages)$/, { color: '#3E63DD', label: 'Document' }],
  [/^(xlsx?|ods|csv|tsv|numbers)$/, { color: '#30A46C', label: 'Spreadsheet' }],
  [/^(pptx?|odp|key)$/, { color: '#F76B15', label: 'Presentation' }],
  [/^(md|markdown|txt)$/, { color: '#8E8C99', label: 'Text' }],
  [/^(zip|tar|gz|tgz|7z|rar)$/, { color: '#AD7F58', label: 'Archive' }],
  [/^(mp3|m4a|wav|flac|ogg|aac)$/, { color: '#8E4EC6', label: 'Audio' }],
  [/^(mov|mp4|m4v|webm|mkv)$/, { color: '#0090FF', label: 'Video' }]
]

const CODE: FileKind = { color: '#6E56CF', label: 'Code' }
const OTHER: FileKind = { color: '#8E8C99', label: 'File' }

const CODE_EXTENSIONS =
  /^(js|jsx|ts|tsx|mjs|cjs|py|rs|go|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|json|yaml|yml|toml|xml|html|css|sql|ino)$/

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')

  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function kindOf(name: string): FileKind {
  const ext = extensionOf(name)

  return (
    KINDS.find(([pattern]) => pattern.test(ext))?.[1] ?? (CODE_EXTENSIONS.test(ext) ? CODE : OTHER)
  )
}

/** "951kB", "1.2MB": the size the way a file card shows it. */
export function cardSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)}kB`
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
