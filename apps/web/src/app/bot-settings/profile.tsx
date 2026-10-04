import { Switch } from '../../components/ui/switch'
import type { Bot } from '../../lib/types'

import { AvatarPicker, Group, Heading, IdentityFields, Row, type SaveBot } from './shared'

export function ProfileTab({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
  return (
    <div>
      <Heading description="How this bot appears in the roster and in rooms.">Profile</Heading>
      <div className="space-y-8">
        <AvatarPicker bot={bot} onSave={onSave} />
        <IdentityFields bot={bot} onSave={onSave} />
        <Group title="Sharing">
          <Row
            control={
              <Switch
                aria-label="Shareable with other users"
                checked={bot.shareable ?? false}
                onCheckedChange={checked => void onSave({ shareable: checked })}
              />
            }
            description="Other users on this daemon can talk to this bot."
            title="Shareable"
          />
        </Group>
      </div>
    </div>
  )
}
