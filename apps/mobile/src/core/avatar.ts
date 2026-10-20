/** Uploaded avatars may already include their data URL prefix. */
export function avatarSrc(avatar?: null | { data: string; mime: string }): string | null {
  if (!avatar?.data) return null
  return avatar.data.startsWith('data:') ? avatar.data : `data:${avatar.mime};base64,${avatar.data}`
}

/**
 * The bot's photo, if it has one. A face picked in an app also arrives as
 * `avatar` (its PNG), but it is not a photo: the face is drawn live instead.
 */
export function botPhoto(bot?: null | {
  avatar?: null | { data: string; mime: string }
  face?: unknown
}): string | null {
  return bot?.face ? null : avatarSrc(bot?.avatar)
}
