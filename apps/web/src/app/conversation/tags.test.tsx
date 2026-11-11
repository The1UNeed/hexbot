import type * as Router from '@tanstack/react-router'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Bot, Room, Section } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { usePlugins } from '../../stores/plugins'
import { useRooms } from '../../stores/rooms'
import { useSections } from '../../stores/sections'
import { useUi } from '../../stores/ui'

import { TagScope } from './tags'

import { Markdown } from './index'

const navigate = vi.fn()

vi.mock('@tanstack/react-router', async original => ({
  ...(await original<typeof Router>()),
  useRouter: () => ({ navigate })
}))

const bot = (name: string, display_name: string) =>
  ({ avatar: null, display_name, name }) as unknown as Bot

const said = (text: string, scope: Partial<Parameters<typeof TagScope>[0]> = {}) =>
  render(
    <TagScope speaker="hexbot" {...scope}>
      <Markdown text={text} />
    </TagScope>
  )

describe('tags in a message', () => {
  beforeEach(() => {
    navigate.mockClear()
    useBots.setState({
      byName: { biology: bot('biology', 'Biology'), hexbot: bot('hexbot', 'HexBot') }
    })
    useSections.setState({ byId: {} })
    useRooms.setState({ byId: {} })
    useUi.setState({ thread: null })
    usePlugins.setState({ sought: null })
  })

  it('draws a bot by its face and name, and opens its conversation with the speaker', () => {
    said('@biology is created, and I shared your course context.')
    const tag = screen.getByRole('button', { name: 'Open the conversation with Biology' })
    expect(tag).toHaveTextContent('Biology')
    expect(tag).not.toHaveTextContent('@biology')
    expect(screen.getByRole('img', { name: 'Biology' })).toBeVisible()
    fireEvent.click(tag)
    expect(useUi.getState().thread).toEqual({ bot: 'biology', peer: 'hexbot' })
  })

  it('opens the thread that exists when the named bot was the one that asked', () => {
    useSections.setState({
      byId: { t: { bot: 'hexbot', id: 't', peer_bot: 'biology' } as unknown as Section }
    })
    said('[Biology](hexbot:bot/biology) asked me for the dates.')
    fireEvent.click(screen.getByRole('button', { name: 'Open the conversation with Biology' }))
    expect(useUi.getState().thread).toEqual({ bot: 'hexbot', peer: 'biology' })
  })

  it("opens the bot's chat with you when you named it, or it named itself", () => {
    useSections.setState({
      byId: { c: { bot: 'biology', id: 'c' } as unknown as Section }
    })
    said('Ask @biology about it.', { speaker: null })
    fireEvent.click(screen.getByRole('button', { name: "Open Biology's chat" }))
    expect(navigate).toHaveBeenCalledWith({
      params: { bot: 'biology', section: 'c' },
      to: '/b/$bot/s/$section'
    })
    expect(useUi.getState().thread).toBeNull()
  })

  it('leaves a handle that is no bot as written, and never tags code', () => {
    const { container } = said('Ping @nobody, or run `npm i @biology/x`.')
    expect(container).toHaveTextContent('Ping @nobody, or run npm i @biology/x.')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('draws a web page with an icon and opens it in the browser', () => {
    said('The [MIT CER guide](https://www.mit.edu/cer) explains it. https://www.taobao.com/')
    const guide = screen.getByRole('link', { name: 'MIT CER guide' })
    expect(guide).toHaveAttribute('href', 'https://www.mit.edu/cer')
    expect(guide).toHaveAttribute('target', '_blank')
    expect(guide.querySelector('img')).toHaveAttribute('src', 'https://www.mit.edu/favicon.ico')
    // A link written as its own address shows the site, not the scheme.
    expect(screen.getByRole('link', { name: 'taobao.com' })).toBeVisible()
  })

  it('opens a file beside the chat, and only names it where nothing can open', () => {
    const onFile = vi.fn()
    const { unmount } = said('Here is [the report](/Users/me/out/report.pdf).', { onFile })
    fireEvent.click(screen.getByRole('button', { name: 'the report' }))
    expect(onFile).toHaveBeenCalledWith({
      mime: 'application/pdf',
      name: 'report.pdf',
      path: '/Users/me/out/report.pdf'
    })
    unmount()
    said('Here is [the report](/Users/me/out/report.pdf).')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('the report')).toBeVisible()
  })

  it('opens a room by its name, a Settings page and a plugin, and only marks scheduled jobs', () => {
    useRooms.setState({ byId: { r1: { id: 'r1', name: 'Study group' } as unknown as Room } })
    said(
      'See [Study group](hexbot:room/study%20group), [my jobs](hexbot:jobs), ' +
        '[Passwords](hexbot:settings/passwords), [Notion](hexbot:plugin/notion) ' +
        'and [a room that is gone](hexbot:room/nowhere).'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Study group' }))
    expect(navigate).toHaveBeenLastCalledWith({ params: { room: 'r1' }, to: '/r/$room' })
    // This app has no page for scheduled jobs.
    expect(screen.queryByRole('button', { name: 'my jobs' })).toBeNull()
    expect(screen.getByText('my jobs')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Passwords' }))
    expect(navigate).toHaveBeenLastCalledWith({ params: { tab: 'passwords' }, to: '/settings/$tab' })
    fireEvent.click(screen.getByRole('button', { name: 'Notion' }))
    expect(navigate).toHaveBeenLastCalledWith({ params: { tab: 'plugins' }, to: '/settings/$tab' })
    expect(usePlugins.getState().sought).toEqual({ kind: 'plugin', name: 'notion' })
    expect(screen.queryByRole('button', { name: 'a room that is gone' })).toBeNull()
    expect(screen.getByText(/a room that is gone/)).toBeVisible()
  })

  it('keeps any other link an ordinary link', () => {
    said('[Write to me](mailto:me@example.com)')
    expect(screen.getByRole('link', { name: 'Write to me' })).toHaveAttribute(
      'href',
      'mailto:me@example.com'
    )
  })
})
