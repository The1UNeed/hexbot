/** Uploaded avatars may already include their data URL prefix. */
export function avatarSrc(avatar?: null | { data: string; mime: string }): string | null {
  if (!avatar?.data) return null
  return avatar.data.startsWith('data:') ? avatar.data : `data:${avatar.mime};base64,${avatar.data}`
}
