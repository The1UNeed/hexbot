import type { GatewayEvent } from '@hermes/shared'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from '../stores/transcripts'

import type { HistoryRow } from './api'
import { messagesFromHistory } from './api'
import { routeEvent } from './events'

const event = (type: string, payload: Record<string, unknown> = {}) =>
  routeEvent({ type, session_id: 's', payload } as GatewayEvent)

const state = () => useTranscripts.getState().bySession.s!
const restored = () => state().messages.flatMap(message => message.approvals ?? [])

const draftForm = {
  bcc: [],
  body: 'Dear Admissions Team,',
  cc: [],
  from: 'alex@example.com',
  kind: 'email_draft',
  service: 'microsoft',
  service_name: 'Outlook',
  subject: 'Report cards',
  to: ['admission@example.com']
}

const pluginForm = (id: string) => ({
  action: 'enable',
  bot: 'hexbot',
  fields: [],
  id,
  kind: 'plugin',
  name: id
})

const call = (id: string, name: string, args: object) => ({
  id,
  function: { name, arguments: JSON.stringify(args) }
})

beforeEach(() => {
  useTranscripts.setState({ bySession: {} })
  setTranscriptEffects({ touchSection: () => {}, notify: () => {}, ackApproval: () => {} })
})
afterEach(resetTranscriptEffects)

it('keeps the sent card when the chat is read again while the bot still works', () => {
  event('message.start', { turn_id: 'run' })
  event('tool.start', {
    message_id: 'a1',
    turn_id: 'run',
    tool_id: 'm1',
    name: 'hexbot_mail',
    args: { action: 'draft', subject: 'Report cards' }
  })
  event('approval.request', { form: draftForm, message_id: 'a1', request_id: 'r1', turn_id: 'run' })
  // Sent from another app while this one was away: no approval.resolved here.
  event('tool.complete', { message_id: 'a1', turn_id: 'run', tool_id: 'm1', result_text: 'x' })

  const rows: HistoryRow[] = [
    {
      role: 'assistant',
      row_id: 'a1',
      turn_id: 'run',
      text: '',
      tool_calls: [call('m1', 'hexbot_mail', { action: 'draft', subject: 'Report cards' })]
    },
    {
      role: 'tool',
      row_id: 't1',
      turn_id: 'run',
      tool_call_id: 'm1',
      name: 'hexbot_mail',
      text: JSON.stringify({
        account: 'microsoft',
        sent: true,
        subject: 'Report cards',
        to: ['admission@example.com']
      })
    }
  ]

  // The daemon no longer waits on the card, and the turn goes on.
  useTranscripts.getState().open(
    's',
    'chat',
    messagesFromHistory(rows),
    { reports: [] },
    {
      busy: true,
      pending: [],
      readAt: Date.now() + 1
    }
  )

  expect(state().approvals).toEqual([])
  expect(restored()).toMatchObject([
    { decision: 'once', messageId: 'a1', outcome: { mail_action: 'send' }, requestId: 'm1' }
  ])
})

it('lets each rebuilt card stand for one live card only', () => {
  event('message.start', { turn_id: 'run' })

  for (const [tool, request, id] of [
    ['p1', 'r1', 'connector:notion'],
    ['p2', 'r2', 'connector:github']
  ] as const) {
    event('tool.start', {
      message_id: 'a1',
      turn_id: 'run',
      tool_id: tool,
      name: 'hexbot_plugins',
      args: { action: 'enable', id }
    })
    event('approval.request', {
      form: pluginForm(id),
      message_id: 'a1',
      request_id: request,
      turn_id: 'run'
    })
    event('approval.resolved', { request_id: request, choice: 'once' })
  }

  // History has stored only the first result so far.
  const rows: HistoryRow[] = [
    {
      role: 'assistant',
      row_id: 'a1',
      turn_id: 'run',
      text: '',
      tool_calls: [
        call('p1', 'hexbot_plugins', { action: 'enable', id: 'connector:notion' }),
        call('p2', 'hexbot_plugins', { action: 'enable', id: 'connector:github' })
      ]
    },
    {
      role: 'tool',
      row_id: 't1',
      turn_id: 'run',
      tool_call_id: 'p1',
      name: 'hexbot_plugins',
      text: '{"name":"Notion","on":true,"plugin":"connector:notion"}'
    }
  ]

  useTranscripts.getState().open('s', 'chat', messagesFromHistory(rows), { reports: [] })

  expect(restored().map(card => card.requestId)).toEqual(['p1'])
  expect(state().approvals.map(card => card.requestId)).toEqual(['r2'])

  // The same read again never lets that card stand in for the other one.
  useTranscripts.getState().open('s', 'chat', messagesFromHistory(rows), { reports: [] })
  expect(state().approvals.map(card => card.requestId)).toEqual(['r2'])
})

it('matches a rebuilt card to the live card it names, whatever order they finished in', () => {
  event('message.start', { turn_id: 'run' })

  for (const [tool, request, id] of [
    ['p1', 'r1', 'connector:notion'],
    ['p2', 'r2', 'connector:github']
  ] as const) {
    event('tool.start', {
      message_id: 'a1',
      turn_id: 'run',
      tool_id: tool,
      name: 'hexbot_plugins',
      args: { action: 'enable', id }
    })
    event('approval.request', {
      form: pluginForm(id),
      message_id: 'a1',
      request_id: request,
      turn_id: 'run'
    })
    event('approval.resolved', { request_id: request, choice: 'once' })
  }

  // Only the second one has finished.
  const rows: HistoryRow[] = [
    {
      role: 'assistant',
      row_id: 'a1',
      turn_id: 'run',
      text: '',
      tool_calls: [
        call('p1', 'hexbot_plugins', { action: 'enable', id: 'connector:notion' }),
        call('p2', 'hexbot_plugins', { action: 'enable', id: 'connector:github' })
      ]
    },
    {
      role: 'tool',
      row_id: 't2',
      turn_id: 'run',
      tool_call_id: 'p2',
      name: 'hexbot_plugins',
      text: '{"name":"GitHub","on":true,"plugin":"connector:github"}'
    }
  ]

  useTranscripts.getState().open('s', 'chat', messagesFromHistory(rows), { reports: [] })

  expect(restored().map(card => card.requestId)).toEqual(['p2'])
  expect(state().approvals.map(card => card.requestId)).toEqual(['r1'])
})

it('matches by the tool call that showed the card, even when two name the same thing', () => {
  event('message.start', { turn_id: 'run' })

  for (const [tool, request] of [
    ['m1', 'r1'],
    ['m2', 'r2']
  ] as const) {
    event('tool.start', {
      message_id: 'a1',
      turn_id: 'run',
      tool_id: tool,
      name: 'hexbot_mail',
      args: { action: 'draft', subject: 'Report cards' }
    })
    event('approval.request', {
      form: draftForm,
      message_id: 'a1',
      request_id: request,
      tool_id: tool,
      turn_id: 'run'
    })
    event('approval.resolved', {
      request_id: request,
      choice: 'once',
      mail_action: 'send',
      draft: draftForm
    })
  }

  const sent = JSON.stringify({ account: 'microsoft', sent: true, subject: 'Report cards' })

  const draft = (id: string) =>
    call(id, 'hexbot_mail', { action: 'draft', subject: 'Report cards' })

  // The second one finished first.
  useTranscripts.getState().open(
    's',
    'chat',
    messagesFromHistory([
      {
        role: 'assistant',
        row_id: 'a1',
        turn_id: 'run',
        text: '',
        tool_calls: [draft('m1'), draft('m2')]
      },
      {
        role: 'tool',
        row_id: 't2',
        turn_id: 'run',
        tool_call_id: 'm2',
        name: 'hexbot_mail',
        text: sent
      }
    ]),
    { reports: [] }
  )

  expect(state().approvals.map(card => card.requestId)).toEqual(['r1'])

  // A later message reuses a tool id; its card is its own.
  event('message.start', { turn_id: 'next' })
  event('approval.request', {
    form: draftForm,
    message_id: 'b1',
    request_id: 'r3',
    tool_id: 'm2',
    turn_id: 'next'
  })
  event('approval.resolved', {
    request_id: 'r3',
    choice: 'once',
    mail_action: 'send',
    draft: draftForm
  })

  useTranscripts.getState().open(
    's',
    'chat',
    messagesFromHistory([
      {
        role: 'assistant',
        row_id: 'a1',
        turn_id: 'run',
        text: '',
        tool_calls: [draft('m1'), draft('m2')]
      },
      {
        role: 'tool',
        row_id: 't1',
        turn_id: 'run',
        tool_call_id: 'm1',
        name: 'hexbot_mail',
        text: sent
      },
      {
        role: 'tool',
        row_id: 't2',
        turn_id: 'run',
        tool_call_id: 'm2',
        name: 'hexbot_mail',
        text: sent
      },
      { role: 'assistant', row_id: 'b1', turn_id: 'next', text: '', tool_calls: [draft('m2')] },
      {
        role: 'tool',
        row_id: 't3',
        turn_id: 'next',
        tool_call_id: 'm2',
        name: 'hexbot_mail',
        text: sent
      }
    ]),
    { reports: [] }
  )

  expect(state().approvals).toEqual([])
  expect(restored().map(card => `${card.messageId}:${card.requestId}`)).toEqual([
    'a1:m1',
    'a1:m2',
    'b1:m2'
  ])
})

it('keeps both live cards when it cannot tell which one history rebuilt', () => {
  event('message.start', { turn_id: 'run' })

  for (const request of ['r1', 'r2']) {
    event('approval.request', {
      form: draftForm,
      message_id: 'a1',
      request_id: request,
      turn_id: 'run'
    })
    event('approval.resolved', {
      request_id: request,
      choice: 'once',
      mail_action: 'send',
      draft: draftForm
    })
  }

  useTranscripts.getState().open(
    's',
    'chat',
    messagesFromHistory([
      {
        role: 'assistant',
        row_id: 'a1',
        turn_id: 'run',
        text: '',
        tool_calls: [
          call('m1', 'hexbot_mail', { action: 'draft' }),
          call('m2', 'hexbot_mail', { action: 'draft' })
        ]
      },
      {
        role: 'tool',
        row_id: 't1',
        turn_id: 'run',
        tool_call_id: 'm1',
        name: 'hexbot_mail',
        text: JSON.stringify({ account: 'microsoft', sent: true, subject: 'Report cards' })
      }
    ]),
    { reports: [] }
  )

  // No tool ids, and the same subject: shown twice beats gone.
  expect(state().approvals.map(card => card.requestId)).toEqual(['r1', 'r2'])
})

it('never lets an older card with a reused tool id stand in for a newer one', () => {
  event('message.start', { turn_id: 'next' })
  event('approval.request', {
    form: draftForm,
    message_id: 'b1',
    request_id: 'r2',
    tool_id: 'm1',
    turn_id: 'next'
  })
  event('approval.resolved', {
    request_id: 'r2',
    choice: 'once',
    mail_action: 'send',
    draft: draftForm
  })

  // History holds only the earlier turn's card from the same tool id, with no message ids.
  useTranscripts.getState().open(
    's',
    'chat',
    messagesFromHistory([
      {
        role: 'assistant',
        turn_id: 'run',
        text: '',
        tool_calls: [call('m1', 'hexbot_mail', { action: 'draft', subject: 'Report cards' })]
      },
      {
        role: 'tool',
        turn_id: 'run',
        tool_call_id: 'm1',
        name: 'hexbot_mail',
        text: JSON.stringify({ account: 'microsoft', sent: true, subject: 'Report cards' })
      }
    ]),
    { reports: [] }
  )

  expect(state().approvals.map(card => card.requestId)).toEqual(['r2'])
})

it('shows a live card that the user agreed to as failed when its work does', () => {
  event('message.start', { turn_id: 'run' })
  event('tool.start', {
    message_id: 'a1',
    turn_id: 'run',
    tool_id: 'p1',
    name: 'hexbot_plugins',
    args: { action: 'install', name: 'echo' }
  })
  event('approval.request', {
    form: pluginForm('package:echo'),
    message_id: 'a1',
    request_id: 'r1',
    tool_id: 'p1',
    turn_id: 'run'
  })
  event('approval.resolved', { request_id: 'r1', choice: 'once' })
  const error = "The user agreed on the card, but it didn't work: echo is already installed."
  event('tool.complete', {
    message_id: 'a1',
    turn_id: 'run',
    tool_id: 'p1',
    result: { content: [{ type: 'text', text: error }], error }
  })

  expect(state().approvals).toMatchObject([{ decision: 'once', failed: true, requestId: 'r1' }])
})

it('never marks an earlier card failed when a later turn reuses its tool id', () => {
  for (const [turn, message, request] of [
    ['run', 'a1', 'old-card'],
    ['next', 'b1', 'new-card']
  ] as const) {
    event('message.start', { turn_id: turn })
    event('approval.request', {
      form: pluginForm('package:echo'),
      message_id: message,
      request_id: request,
      tool_id: 'p1',
      turn_id: turn
    })
    event('approval.resolved', { request_id: request, choice: 'once' })
  }

  const error = "The user agreed on the card, but it didn't work: echo is already installed."
  event('tool.complete', {
    message_id: 'b1',
    turn_id: 'next',
    tool_id: 'p1',
    result: { content: [{ type: 'text', text: error }], error }
  })

  expect(state().approvals.map(card => [card.requestId, Boolean(card.failed)])).toEqual([
    ['old-card', false],
    ['new-card', true]
  ])
})
