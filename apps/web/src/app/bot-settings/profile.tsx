import type { Bot } from '../../lib/types'

import { AvatarPicker, Heading, IdentityFields, type SaveBot } from './shared'

export function ProfileTab({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
  return (
    <div>
      <Heading description="How this bot appears in the roster and in rooms.">Profile</Heading>
      <div className="space-y-8">
        <AvatarPicker bot={bot} onSave={onSave} />
        <IdentityFields bot={bot} onSave={onSave} />
      </div>
    </div>
  )
}
