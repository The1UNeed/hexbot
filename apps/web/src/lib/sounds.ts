/**
 * Hexbot's sound cues, synthesised with Web Audio: a few soft sine notes each,
 * no recorded samples. Off until the user turns them on in Settings,
 * Appearance, and silent while the window is hidden, where a notification
 * speaks for the bot instead.
 */

import { useEffect, useRef } from 'react'

import { useUi } from '../stores/ui'

/** A bot started on your message, finished it, or needs you to decide something. */
export type SoundCue = 'ask' | 'done' | 'start'

interface Note {
  /** Seconds after the cue starts. */
  at: number
  /** Seconds until the note has faded out. */
  decay: number
  hz: number
  /** Peak level, before the master volume. */
  level: number
}

export const CUES: Record<SoundCue, Note[]> = {
  // One soft, low tap: the message was picked up.
  start: [{ at: 0, decay: 0.16, hz: 587.33, level: 0.5 }],
  // A rising fifth that settles: the reply is in.
  done: [
    { at: 0, decay: 0.3, hz: 783.99, level: 0.7 },
    { at: 0.09, decay: 0.5, hz: 1174.66, level: 0.6 }
  ],
  // Two quick taps a step apart: a question waits for you.
  ask: [
    { at: 0, decay: 0.18, hz: 880, level: 0.7 },
    { at: 0.14, decay: 0.28, hz: 987.77, level: 0.7 }
  ]
}

/** Quiet enough to sit under music or a call. */
const VOLUME = 0.12

let context: AudioContext | null = null

function audio(): AudioContext | null {
  if (typeof window === 'undefined' || typeof window.AudioContext === 'undefined') {
    return null
  }

  context ??= new window.AudioContext()

  if (context.state === 'suspended') {
    void context.resume().catch(() => undefined)
  }

  return context
}

/**
 * Prepares audio inside a click, where browsers allow it to start, then plays
 * `cue` so the user hears what they turned on.
 */
export function primeSounds(cue: SoundCue = 'done'): void {
  if (audio()) {
    play(cue)
  }
}

function play(cue: SoundCue): void {
  const ctx = audio()

  if (!ctx) {
    return
  }

  const master = ctx.createGain()
  master.gain.value = VOLUME
  master.connect(ctx.destination)

  const now = ctx.currentTime + 0.01
  let end = now

  for (const note of CUES[cue]) {
    const start = now + note.at
    const stop = start + note.decay
    const tone = ctx.createOscillator()
    const envelope = ctx.createGain()

    tone.type = 'sine'
    tone.frequency.value = note.hz
    envelope.gain.setValueAtTime(0.0001, start)
    envelope.gain.exponentialRampToValueAtTime(note.level, start + 0.012)
    envelope.gain.exponentialRampToValueAtTime(0.0001, stop)
    tone.connect(envelope).connect(master)
    tone.start(start)
    tone.stop(stop + 0.02)
    end = Math.max(end, stop + 0.02)
  }

  // Let the graph go once the last note has faded.
  window.setTimeout(() => master.disconnect(), Math.ceil((end - ctx.currentTime) * 1000) + 50)
}

/** Plays `cue` when the user has sounds on and is looking at the window. */
export function playCue(cue: SoundCue): void {
  if (!useUi.getState().sounds || (typeof document !== 'undefined' && document.hidden)) {
    return
  }

  play(cue)
}

/**
 * Cues for the open conversation: `start` when a turn begins, `done` when it
 * ends without an error, `ask` when another question or approval waits for
 * you. Opening a conversation, or switching to another, plays nothing.
 */
export function useTurnCues(
  conversation: null | string | undefined,
  { failed = false, streaming, waiting }: { failed?: boolean; streaming: boolean; waiting: number }
): void {
  const last = useRef({ conversation, streaming, waiting })

  useEffect(() => {
    const before = last.current
    last.current = { conversation, streaming, waiting }

    if (!conversation || before.conversation !== conversation) {
      return
    }

    if (waiting > before.waiting) {
      playCue('ask')
    } else if (streaming && !before.streaming) {
      playCue('start')
    } else if (!streaming && before.streaming && !failed) {
      playCue('done')
    }
  }, [conversation, failed, streaming, waiting])
}
