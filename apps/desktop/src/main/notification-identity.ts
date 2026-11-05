import type { App } from 'electron'

/** Must run before app.whenReady; Windows toasts use the shortcut's app ID. */
export function setNotificationIdentity(
  app: Pick<App, 'setAppUserModelId'>,
  platform: NodeJS.Platform,
  appId: string
): void {
  if (platform === 'win32') app.setAppUserModelId(appId)
}
