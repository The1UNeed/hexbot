export function attachmentPrompt(text: string, hasAttachments: boolean): string {
  return text.trim() || (hasAttachments ? 'Please review the attached files.' : '')
}
export function imageMime(name: string, mime?: string): string | undefined {
  const images = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
  if (mime && images.includes(mime)) return mime
  const extension = name.toLowerCase().split('.').at(-1) ?? ''
  return (
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp'
    } as Record<string, string>
  )[extension]
}
/** What the question tool receives: one answer, or every chosen answer as a JSON array, as on the web. */
export function encodeAnswer(multiSelect: boolean, chosen: string[], typed: string): string {
  const own = typed.trim()
  if (multiSelect) return JSON.stringify(own ? [...chosen, own] : chosen)
  return own || chosen[0] || ''
}
