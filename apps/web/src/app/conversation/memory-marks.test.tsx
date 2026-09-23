import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { Message, ToolCall } from '../../lib/types'

import { MemoryMarks } from './memory-marks'
import { memoryMarks, visibleSteps } from './steps'

const call = (partial: Partial<ToolCall>): ToolCall => ({
  args: null,
  durationS: 1,
  name: 'memory',
  result: '{"success": true}',
  startedAt: 0,
  status: 'ok',
  toolId: partial.toolId ?? 'tool',
  ...partial
})

const message = (toolCalls: ToolCall[]): Message => ({
  attachments: [],
  createdAt: 0,
  id: 'm',
  role: 'assistant',
  streaming: false,
  text: 'Done.',
  toolCalls
})

describe('memoryMarks', () => {
  it('reads memory adds, replaces, batches and soul writes; skips failures and reads', () => {
    const marks = memoryMarks(
      message([
        call({ args: { action: 'add', content: 'User prefers short answers' }, toolId: 'a' }),
        call({
          args: { action: 'replace', new_text: 'Lives in Auckland', old_text: 'Lives in NZ' },
          toolId: 'b'
        }),
        call({
          args: { operations: [{ action: 'remove', old_text: 'Old' }, { action: 'add', content: 'New' }] },
          toolId: 'c'
        }),
        call({ args: { action: 'add', content: 'Rejected' }, result: '{"success": false}', toolId: 'd' }),
        // Restored history marks every row ok; the soul tool's error is in the result.
        call({
          args: { action: 'write', text: 'Refused' },
          name: 'hexbot_soul',
          result: '{"error": "the soul could not be written"}',
          toolId: 'd2'
        }),
        call({ args: { action: 'add', content: 'Still running' }, status: 'running', toolId: 'e' }),
        call({ args: { action: 'read' }, name: 'hexbot_soul', toolId: 'f' }),
        call({ args: { action: 'write', text: 'You are Scout, blunt.' }, name: 'hexbot_soul', toolId: 'g' })
      ])
    )

    expect(marks).toEqual([
      { kind: 'memory', text: 'User prefers short answers' },
      { kind: 'memory', text: 'Lives in Auckland' },
      { kind: 'memory', text: 'Removed: Old\nNew' },
      { kind: 'soul', text: 'You are Scout, blunt.' }
    ])
  })

  it('keeps both tools out of the step list', () => {
    expect(visibleSteps([call({}), call({ name: 'hexbot_soul' })])).toEqual([])
  })
})

describe('MemoryMarks', () => {
  it('renders nothing for a turn without writes', () => {
    const { container } = render(<MemoryMarks message={message([])} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a mark per write and opens it to the text', () => {
    render(
      <MemoryMarks
        message={
          message([
            call({ args: { action: 'add', content: 'User prefers short answers' } }),
            call({ args: { action: 'write', text: 'You are Scout, blunt.' }, name: 'hexbot_soul', toolId: 's' })
          ])
        }
      />
    )
    expect(screen.getByRole('button', { name: 'Memory updated' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Soul updated' }))
    expect(screen.getByText('You are Scout, blunt.')).toBeVisible()
    expect(screen.queryByText('User prefers short answers')).toBeNull()
  })
})
