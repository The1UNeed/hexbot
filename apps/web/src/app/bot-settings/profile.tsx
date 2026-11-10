import type { Bot } from '../../lib/types'

import { Heading, IdentityFields, ProfileFace, type SaveBot } from './shared'

export function ProfileTab({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
  return (
    <div>
      <Heading description="How this bot appears in the roster and in rooms.">Profile</Heading>
      <div className="space-y-8">
        <ProfileFace bot={bot} />
        <IdentityFields bot={bot} onSave={onSave} />
      </div>
    </div>
  )
}
