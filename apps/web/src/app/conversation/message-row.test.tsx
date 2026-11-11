import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import * as api from '../../lib/api'
import type { Message } from '../../lib/types'
import {
  resetTranscriptEffects,
  setTranscriptEffects,
  useTranscripts
} from '../../stores/transcripts'

import { CheckingRow, MessageRow } from './index'

const message = (partial: Partial<Message>): Message => ({
  attachments: [],
  createdAt: 0,
  id: 'm',
  role: 'assistant',
  streaming: false,
  text: '',
  toolCalls: [],
  ...partial
})

const row = (partial: Partial<Message>) =>
  render(<MessageRow message={message(partial)} onImage={() => {}} onRetry={() => {}} />)

describe('MessageRow', () => {
  it('shows only finished messages while the turn runs', () => {
    row({ parts: ['I will check.'], streaming: true, text: 'Do' })
    expect(screen.getByText('I will check.')).toBeInTheDocument()
    expect(screen.queryByText('Do')).toBeNull()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('draws each message of a finished turn as its own bubble', () => {
    row({ parts: ['I will check.'], text: 'Done.' })
    expect(screen.getByText('I will check.')).toBeInTheDocument()
    expect(screen.getByText('Done.')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows a finished turn as its bubbles alone, past ones included', () => {
    row({
      createdAt: 1,
      text: 'I set my soul.',
      thinking: 'The user wants short answers.',
      toolCalls: [
        {
          args: { action: 'write', text: 'Warm but efficient.' },
          durationS: 1,
          name: 'hexbot_soul',
          result: '{"ok":true}',
          startedAt: 0,
          status: 'ok',
          toolId: 's1'
        },
        {
          args: { action: 'add', content: 'Files are local.' },
          durationS: 1,
          name: 'memory',
          result: '{"success":true}',
          startedAt: 0,
          status: 'ok',
          toolId: 'm1'
        },
        {
          args: null,
          durationS: 12,
          name: 'terminal',
          result: 'ok',
          startedAt: 0,
          status: 'ok',
          summary: 'ls',
          toolId: 't1'
        }
      ],
      workUntil: 13_000
    })

    expect(screen.getByTestId('bot-message')).toHaveTextContent(/^I set my soul\.$/)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText(/Soul updated|Memory updated|Thought for|Worked for/)).toBeNull()
    expect(screen.queryByText(/short answers|Warm but efficient|Files are local/)).toBeNull()
  })

  it('draws nothing for a step that only used tools, but keeps the gap above an ask', () => {
    const call = (name: string, args: Record<string, unknown> = {}) => ({
      args,
      durationS: 1,
      name,
      result: null,
      startedAt: 1,
      status: 'ok' as const,
      toolId: name
    })

    const { container } = row({ toolCalls: [call('hexbot_plugins')] })
    expect(container).toBeEmptyDOMElement()
    container.remove()

    row({ toolCalls: [call('message_bot', { to: 'writer' })] })
    expect(screen.getByTestId('bot-message')).toHaveClass('pt-4')
    expect(screen.getByTestId('asking-rows')).toBeInTheDocument()
  })

  it('keeps Copy beside your own messages', () => {
    row({ role: 'user', text: 'Hi' })
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })

  it('draws a visual between what the bot said first and its final reply', () => {
    row({
      parts: ['Here are the costs.'],
      text: 'March doubled.',
      toolCalls: [
        {
          args: { html: '<p>chart</p>', title: 'Costs' },
          durationS: 0,
          name: 'hexbot_show_html',
          result: null,
          startedAt: 0,
          status: 'ok',
          toolId: 't1'
        }
      ]
    })

    const frame = screen.getByTitle('Costs')
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    expect(frame).toHaveAttribute('src', '/visual-frame.html')
    const before = screen.getByText('Here are the costs.')
    const after = screen.getByText('March doubled.')
    expect(before.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(frame.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps the same frame when the final reply lands under it', () => {
    const toolCalls: Message['toolCalls'] = [
      {
        args: { html: '<p>chart</p>', title: 'Costs' },
        durationS: 0,
        name: 'hexbot_show_html',
        result: null,
        startedAt: 0,
        status: 'ok',
        toolId: 't1'
      }
    ]

    const view = row({ parts: ['Here are the costs.'], streaming: true, text: 'March', toolCalls })
    const frame = screen.getByTitle('Costs')

    view.rerender(
      <MessageRow
        message={message({ parts: ['Here are the costs.'], text: 'March doubled.', toolCalls })}
        onImage={() => {}}
        onRetry={() => {}}
      />
    )

    expect(screen.getByTitle('Costs')).toBe(frame)
    expect(frame.compareDocumentPosition(screen.getByText('March doubled.'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })
})

describe('CheckingRow', () => {
  it('stays working after a card ends the message while a step is checked, until the clear', () => {
    useTranscripts.setState({ bySession: {} })
    setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
    const actions = useTranscripts.getState()
    const transcript = () => useTranscripts.getState().bySession.s
    actions.messageStart('s')
    actions.statusUpdate('s', { kind: 'checking', text: 'Checking this step' })
    // While a message streams, its own row shows the line.
    const { rerender } = render(<CheckingRow transcript={transcript()} />)
    expect(screen.queryByRole('status')).toBeNull()
    // A card ends the message while the review still runs.
    actions.approvalRequest('s', { request_id: 'a' })
    resetTranscriptEffects()
    rerender(<CheckingRow transcript={transcript()} />)
    expect(screen.getByRole('status', { name: 'Bot is working' })).toBeVisible()
    actions.statusUpdate('s', { kind: 'checking', text: '' })
    rerender(<CheckingRow transcript={transcript()} />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('leaves the line to the message while one of its steps still runs', () => {
    useTranscripts.setState({ bySession: {} })
    setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
    const actions = useTranscripts.getState()
    actions.messageStart('s')
    actions.toolStart('s', { name: 'terminal', tool_id: 'a' })
    actions.toolStart('s', { name: 'terminal', tool_id: 'b' })
    actions.statusUpdate('s', { kind: 'checking', text: 'Checking this step' })
    // Review A's card ends the message while review B still runs.
    actions.approvalRequest('s', { request_id: 'a' })
    resetTranscriptEffects()
    const transcript = useTranscripts.getState().bySession.s!

    render(
      <>
        <MessageRow
          message={transcript.messages.findLast(item => item.role === 'assistant')!}
          onImage={() => {}}
          onRetry={() => {}}
        />
        <CheckingRow transcript={transcript} />
      </>
    )

    expect(screen.getAllByRole('status')).toHaveLength(1)
  })
})

describe('MessageRow files', () => {
  const file = {
    id: 'f',
    kind: 'file' as const,
    mime: 'text/csv',
    name: 'pins.csv',
    path: '/s/attachments/pins.csv',
    size: 2048
  }

  const image = {
    dataUrl: 'data:image/png;base64,AA==',
    id: 'i',
    kind: 'image' as const,
    mime: 'image/png',
    name: 'board.png',
    size: 10
  }

  it('opens a picture over the chat and any other file beside it', () => {
    const onFile = vi.fn()
    const onImage = vi.fn()
    render(
      <MessageRow
        message={message({ attachments: [file, image], role: 'user', text: 'Check these' })}
        onFile={onFile}
        onImage={onImage}
        onRetry={() => {}}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open pins.csv beside the chat' }))
    expect(onFile).toHaveBeenCalledWith({
      mime: 'text/csv',
      name: 'pins.csv',
      path: '/s/attachments/pins.csv',
      url: undefined
    })
    expect(onImage).not.toHaveBeenCalled()

    fireEvent.click(screen.getByAltText('board.png'))
    expect(onImage).toHaveBeenCalledWith('data:image/png;base64,AA==')
  })

  it('keeps Recall on a message of files alone, with nothing to copy', () => {
    const onRecall = vi.fn()
    render(
      <MessageRow
        message={message({ attachments: [file], role: 'user', text: '' })}
        onFile={() => {}}
        onImage={() => {}}
        onRecall={onRecall}
        onRetry={() => {}}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Recall' }))
    expect(onRecall).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull()
  })

  it('plays a video where it is', () => {
    render(
      <MessageRow
        message={message({
          attachments: [
            {
              id: 'v',
              kind: 'video',
              mime: 'video/mp4',
              name: 'bench.mp4',
              size: 4000,
              url: 'blob:bench'
            }
          ],
          role: 'user',
          text: ''
        })}
        onFile={() => {}}
        onImage={() => {}}
        onRetry={() => {}}
      />
    )

    const video = screen.getByLabelText('bench.mp4')
    expect(video.tagName).toBe('VIDEO')
    expect(video).toHaveAttribute('src', 'blob:bench')
    expect(video).toHaveAttribute('controls')
  })

  it('plays what the bot made or shared from the daemon, under its reply', async () => {
    const read = vi.spyOn(api, 'filesRead').mockImplementation(async (_session, path) => ({
      data_url: `data:${path.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4'};base64,AAAA`,
      mime: path.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4',
      modified: 0,
      name: path.split('/').pop()!,
      path,
      size: 3,
      version: 'v'
    }))

    const made = vi.fn(() => 'blob:made')
    URL.createObjectURL = made
    URL.revokeObjectURL = vi.fn()

    const voice = '/home/profiles/owl/artifacts/audio/a1.mp3'

    render(
      <MessageRow
        message={message({
          text: 'Here it is.',
          toolCalls: [
            {
              args: { text: 'Hello' },
              durationS: 0,
              name: 'text_to_speech',
              // Live, a Pi result: its text and its details name the file once.
              result: {
                content: [{ text: JSON.stringify({ media: `MEDIA:${voice}` }), type: 'text' }],
                details: { file_path: voice, media: `MEDIA:${voice}` }
              },
              startedAt: 0,
              status: 'ok',
              toolId: 't'
            },
            {
              args: { path: 'clip.mp4' },
              durationS: 0,
              name: 'hexbot_share_file',
              result: '{"name":"clip.mp4","shared":true,"size":3}',
              startedAt: 0,
              status: 'ok',
              toolId: 's'
            },
            {
              // It shared the voice reply too: it still shows once.
              args: { path: voice },
              durationS: 0,
              name: 'hexbot_share_file',
              result: '{"name":"a1.mp3","shared":true,"size":3}',
              startedAt: 0,
              status: 'ok',
              toolId: 'v'
            },
            {
              args: { path: 'notes.md' },
              durationS: 0,
              name: 'hexbot_share_file',
              result: '{"name":"notes.md","shared":true,"size":3}',
              startedAt: 0,
              status: 'ok',
              toolId: 'n'
            },
            {
              args: {},
              durationS: 0,
              name: 'video_generate',
              // From history, the result's text.
              result: '{"media":"MEDIA:/art/videos/lake.mp4","video":"https://fal.test/lake"}',
              startedAt: 0,
              status: 'ok',
              toolId: 'g'
            },
            {
              args: { text: 'Again' },
              durationS: 0,
              name: 'text_to_speech',
              result: { error: 'speech provider did not create audio' },
              startedAt: 0,
              status: 'error',
              toolId: 'e'
            }
          ]
        })}
        onFile={() => {}}
        onImage={() => {}}
        onRetry={() => {}}
        sessionId="live-1"
      />
    )

    const [audio, ...again] = await screen.findAllByLabelText('a1.mp3')
    expect(again).toEqual([])
    expect(audio!.tagName).toBe('AUDIO')
    expect(audio).toHaveAttribute('src', 'blob:made')
    expect((await screen.findByLabelText('clip.mp4')).tagName).toBe('VIDEO')
    expect((await screen.findByLabelText('lake.mp4')).tagName).toBe('VIDEO')
    // A shared document stays a card that opens beside the chat.
    expect(
      screen.getByRole('button', { name: 'Open notes.md beside the chat' })
    ).toBeInTheDocument()
    expect(read.mock.calls.map(call => call[1]).sort()).toEqual(
      ['/art/videos/lake.mp4', 'clip.mp4', voice].sort()
    )
    // The players sit under the reply, with the files it shared.
    expect(
      audio!.compareDocumentPosition(screen.getByText('Here it is.')) &
        Node.DOCUMENT_POSITION_PRECEDING
    ).toBeTruthy()
    read.mockRestore()
  })

  it('shows no media in a room', () => {
    row({
      text: 'Here it is.',
      toolCalls: [
        {
          args: {},
          durationS: 0,
          name: 'text_to_speech',
          result: '{"media":"MEDIA:/home/artifacts/audio/a1.mp3"}',
          startedAt: 0,
          status: 'ok',
          toolId: 't'
        }
      ]
    })

    expect(screen.getByText('Here it is.')).toBeInTheDocument()
    expect(screen.queryByText('a1.mp3')).toBeNull()
  })

  it('offers the files the bot shared, not the ones it only wrote, and none in a room', () => {
    const step = (name: string, path: string, toolId: string) => ({
      args: { content: '# Plan', path },
      durationS: 0,
      name,
      result: null,
      startedAt: 0,
      status: 'ok' as const,
      toolId
    })

    const wrote = message({
      text: 'I drafted it.',
      toolCalls: [
        step('write', '/work/make_plan.py', 'w1'),
        step('write', '/work/plan.md', 'w2'),
        step('hexbot_share_file', '/work/plan.md', 's')
      ]
    })

    const onFile = vi.fn()

    const { unmount } = render(
      <MessageRow message={wrote} onFile={onFile} onImage={() => {}} onRetry={() => {}} />
    )

    expect(screen.queryByRole('button', { name: 'Open make_plan.py beside the chat' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open plan.md beside the chat' }))
    expect(onFile).toHaveBeenCalledWith({
      mime: 'text/markdown',
      name: 'plan.md',
      path: '/work/plan.md'
    })
    unmount()

    render(<MessageRow message={wrote} onImage={() => {}} onRetry={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Open plan.md beside the chat' })).toBeNull()
  })
})
