import { render, screen } from '@testing-library/react'

import type { Room } from '../../lib/types'

import { RoomCluster } from './room-cluster'

const member = {
  display_name: 'PRX0',
  left_at: null,
  member_id: 'prx0',
  member_kind: 'bot'
} as Room['members'][number]

const discord = {
  channel_id: '1',
  channel_name: 'general',
  guild_id: '2',
  guild_name: 'Team',
  url: 'https://discord.com/channels/2/1'
}

it("marks a Discord room with Discord's badge beside its bot's face", () => {
  render(<RoomCluster bots={{}} room={{ discord, members: [member], name: '#general · PRX0' }} />)
  expect(screen.getByRole('img', { name: 'Discord' })).toBeInTheDocument()
})

it('draws no badge on a room of your own', () => {
  render(<RoomCluster bots={{}} room={{ members: [member], name: 'Garden' }} />)
  expect(screen.queryByRole('img', { name: 'Discord' })).toBeNull()
})
