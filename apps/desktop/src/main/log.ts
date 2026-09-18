import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { hexbotHome } from './backend/paths'

// The main process log, `<home>/logs/desktop.log`. A packaged app has no
// terminal, so anything worth knowing after the fact (updater checks and
// their errors, remote update requests) goes here. Rotated once at 5 MB.
const MAX_BYTES = 5 * 1024 * 1024
type Level = 'info' | 'warn' | 'error'

export function logFile(): string {
  return join(hexbotHome(), 'logs', 'desktop.log')
}

function write(level: Level, message: string): void {
  const line = `${new Date().toISOString()} ${level} ${message}\n`
  try {
    const file = logFile()
    mkdirSync(join(hexbotHome(), 'logs'), { recursive: true })
    if (existsSync(file) && statSync(file).size >= MAX_BYTES) renameSync(file, `${file}.1`)
    appendFileSync(file, line)
  } catch {
    /* logging must never break the app */
  }
  if (process.env.NODE_ENV !== 'production') console[level](message)
}

// The shape electron-updater's `logger` option expects.
export const log = {
  info: (message: string): void => write('info', message),
  warn: (message: string): void => write('warn', message),
  error: (message: string): void => write('error', message),
  debug: (_message: string): void => undefined
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
