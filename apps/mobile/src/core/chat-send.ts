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
