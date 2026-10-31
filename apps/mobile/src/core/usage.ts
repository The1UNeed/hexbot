import { sendUsageEvent, type UsageContext, usageDay, type UsageProperties } from '@hermes/shared'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Crypto from 'expo-crypto'
import { useCallback, useEffect, useState } from 'react'
import { Platform } from 'react-native'
import { version } from '../../../desktop/package.json'

/**
 * Anonymous usage data from the phone (docs/usage-data.md). Off until the
 * user turns it on, on first run or in Settings. A random install id, no
 * person profile, no location; never chat text, names, or daemon addresses.
 * The PostHog key comes from the EAS build profile, so dev builds send nothing.
 */
const STORAGE_KEY = 'hexbot.usage'
const projectKey = () => (process.env.EXPO_PUBLIC_POSTHOG_KEY ?? '').trim()

interface UsageState {
  on?: boolean
  id?: string
  day?: string
}

async function read(): Promise<UsageState> {
  try {
    const value: unknown = JSON.parse((await AsyncStorage.getItem(STORAGE_KEY)) ?? '{}')
    return value && typeof value === 'object' ? (value as UsageState) : {}
  } catch {
    return {}
  }
}
const write = (state: UsageState) => AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state))

// Every read-then-write of the stored choice runs in turn, so a daily check
// that started before an opt-out can never write `on: true` back over it.
let queue: Promise<unknown> = Promise.resolve()
function inTurn<T>(step: () => Promise<T>): Promise<T> {
  const next = queue.then(step, step)
  queue = next.catch(() => undefined)
  return next
}

/** Only real phone and tablet builds with a project key can send. */
export const usageAvailable = () =>
  (Platform.OS === 'ios' || Platform.OS === 'android') && projectKey().length > 0

export const loadUsageData = async () => (await read()).on === true

async function context(send?: typeof fetch) {
  const state = await read()
  if (state.on !== true || !usageAvailable()) return null
  if (!state.id) {
    state.id = Crypto.randomUUID()
    await write(state)
  }
  const usage: UsageContext = {
    id: state.id,
    key: projectKey(),
    platform: Platform.OS,
    surface: 'mobile',
    version
  }
  return { send, state, usage }
}

export async function captureUsage(
  event: string,
  properties: UsageProperties = {},
  send?: typeof fetch
): Promise<void> {
  const ready = await inTurn(() => context(send))
  if (ready) await sendUsageEvent(ready.usage, event, properties, ready.send)
}

/** `app_active` at most once per UTC day. */
export async function sendDailyUsage(now = new Date(), send?: typeof fetch): Promise<void> {
  const day = usageDay(now)
  const ready = await inTurn(async () => {
    const found = await context(send)
    if (!found || found.state.day === day) return null
    await write({ ...found.state, day })
    return found
  })
  if (!ready) return
  const device =
    Platform.OS === 'ios' && (Platform as { isPad?: boolean }).isPad ? 'tablet' : 'phone'
  await sendUsageEvent(ready.usage, 'app_active', { device }, ready.send)
}

/** Turning it off forgets the install id; turning it on counts today straight away. */
export async function setUsageData(on: boolean, send?: typeof fetch): Promise<void> {
  await inTurn(async () => write(on ? { ...(await read()), on: true } : { on: false }))
  if (on) await sendDailyUsage(new Date(), send)
}

type ErrorHandler = (error: unknown, fatal?: boolean) => void
interface ErrorUtilsLike {
  getGlobalHandler(): ErrorHandler
  setGlobalHandler(handler: ErrorHandler): void
}

/** Counts uncaught JavaScript errors by their class name, never their message. */
export function watchUsageErrors(): void {
  const utils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils
  if (!utils) return
  const previous = utils.getGlobalHandler()
  utils.setGlobalHandler((error, fatal) => {
    const kind = error instanceof Error ? error.name : 'Error'
    void captureUsage('app_error', { fatal: Boolean(fatal), kind })
    previous(error, fatal)
  })
}

/** The switch for screens: the saved choice, and a setter that saves it. */
export function useUsageData() {
  const [on, setOn] = useState(false)
  useEffect(() => {
    void loadUsageData().then(setOn)
  }, [])
  const change = useCallback((next: boolean) => {
    setOn(next)
    void setUsageData(next)
  }, [])
  return { available: usageAvailable(), on, setOn: change }
}
