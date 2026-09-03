import { crashReporter } from 'electron'
import { readDesktopState, updateDesktopState } from './desktop-state'

const crashUrl = import.meta.env.HEXBOT_CRASH_URL?.trim() ?? ''

export async function startCrashReports(): Promise<void> {
  const enabled = (await readDesktopState()).crashReports === true && crashUrl.length > 0
  crashReporter.start({
    companyName: 'Hexbot',
    productName: 'Hexbot',
    submitURL: crashUrl,
    uploadToServer: enabled
  })
}

export async function setCrashReports(enabled: boolean): Promise<void> {
  if (typeof enabled !== 'boolean') throw new TypeError('Invalid crash report preference')
  await updateDesktopState({ crashReports: enabled })
  crashReporter.setUploadToServer(enabled && crashUrl.length > 0)
}
