import {
  phaseLabel,
  stepLabel,
  stepMood,
  type StepMood,
  type WorkLabel
} from '../../../web/src/lib/work-label'

import type { TurnState } from './types'

/** The waiting row: what the bot does right now, and the face that goes with it. */
export interface Waiting {
  label: WorkLabel
  mood: StepMood | 'thinking'
}

/**
 * What a running turn reads as while nothing is being written: the running
 * step ("Opening" "Taobao"), else "Thinking…" before anything happened and
 * "Working…" between steps. The words come from the step, with the rules the
 * web app uses (apps/web/src/lib/work-label.ts); a bot it asks is named by
 * `nameOf`. While Auto mode checks a step the row only says the bot works.
 */
export function waitingStatus(
  turn: Pick<TurnState, 'checking' | 'interim' | 'tools'>,
  nameOf: (handle: string) => string = handle => handle
): Waiting {
  const step = turn.checking ? undefined : turn.tools.findLast(tool => tool.status === 'running')
  if (!step) {
    const started = turn.checking || turn.tools.length || turn.interim.length
    return started
      ? { label: phaseLabel('working'), mood: 'working' }
      : { label: phaseLabel('thinking'), mood: 'thinking' }
  }
  const label = stepLabel({ args: step.args, name: step.name, summary: step.action })
  return {
    label:
      step.name === 'message_bot' && label.object ? { ...label, object: nameOf(label.object) } : label,
    mood: stepMood({ args: step.args, name: step.name, summary: step.action })
  }
}
