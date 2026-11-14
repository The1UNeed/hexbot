// Build-time constants defined in electron.vite.config.ts (and, for unit
// tests, in vitest.config.ts).
declare const __HEXBOT_CRASH_URL__: string
declare const __HEXBOT_POSTHOG_KEY__: string
declare const __HEXBOT_EDITION__: string
declare const __HEXBOT_CHANNEL__: 'stable' | 'nightly' | 'dev'

// Vite inlines a `?raw` import as the file's text.
declare module '*?raw' {
  const text: string
  export default text
}
/**
 * The extension's OS sandbox (`backend/pi-runtime/isolation.ts`), which a
 * lent computer uses for the commands it runs. Both build configs alias
 * `hexbot-isolation` to it; this is the part the app calls.
 */
declare module 'hexbot-isolation' {
  export function probeIsolation(): string | null
  export function isolationAvailable(): boolean
  export function isolatedCommand(
    command: string,
    home: string,
    outputs?: string[],
    workspace?: string[],
    searchRoots?: string[]
  ): string
  export const credentialPolicy: { environment: string[]; windowsEnvironment: string[] }
}
