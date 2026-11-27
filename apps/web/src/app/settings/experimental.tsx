import { Switch } from '../../components/ui/switch'
import { useUi } from '../../stores/ui'
import { Group, Heading, Row } from '../bot-settings/shared'

/**
 * Features still being tried. Each is off until switched on, is kept on this
 * device only, and may change or go.
 */
export function ExperimentalSettings() {
  const accessTable = useUi(state => state.accessTable)
  const setAccessTable = useUi(state => state.setAccessTable)

  return (
    <div>
      <Heading description="Features still being tried. Each is off until you switch it on, applies to this device only, and may change or go.">
        Experimental
      </Heading>
      <Group>
        <Row
          control={
            <Switch
              aria-label="Plugins as a table"
              checked={accessTable}
              onCheckedChange={setAccessTable}
            />
          }
          description="Settings, Plugins opens as a table of every bot against every plugin, under the account it comes from. Bots with the same label and plugins fold into one row, and changes wait until you review them. Plugins are added and connected there too, from Add plugin."
          title="Plugins as a table"
        />
      </Group>
    </div>
  )
}
