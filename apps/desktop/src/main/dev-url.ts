const DEFAULT_WEB_DEV_URL = 'http://localhost:5173'

export function resolveWebDevUrl(value = process.env.HEXBOT_WEB_DEV_URL): string {
  const candidate = value?.trim()

  return candidate || DEFAULT_WEB_DEV_URL
}
