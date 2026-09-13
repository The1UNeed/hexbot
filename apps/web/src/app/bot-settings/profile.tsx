import { Switch } from '../../components/ui/switch'
import type { Bot } from '../../lib/types'

import { AvatarPicker, cardClass, Heading, IdentityFields, Row, type SaveBot } from './shared'

export function ProfileTab({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
  return (
    <div>
      <Heading description="How this bot appears in the roster and in rooms.">Profile</Heading>
      <AvatarPicker bot={bot} onSave={onSave} />
      <div className="mt-5">
        <IdentityFields bot={bot} onSave={onSave} />
      </div>
      <div className={`${cardClass} mt-5`}>
        <Row
          control={
            <Switch
              aria-label="Shareable with other users"
              checked={bot.shareable ?? false}
              onCheckedChange={checked => void onSave({ shareable: checked })}
            />
          }
          description="Other users on this daemon can talk to this bot"
          title="Shareable"
        />
      </div>
    </div>
  )
}
