import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'

import { Avatar } from '../../components/ui/avatar'
import { Button } from '../../components/ui/button'
import { Switch } from '../../components/ui/switch'
import { type ConnectStatus, connectStatus } from '../../lib/api'
import { botFace } from '../../lib/avatar-builder'
import { getBridge } from '../../lib/bridge'
import {
  sendTestNotification,
  systemNotificationSettings,
  useBrowserNotifications
} from '../../lib/notify'
import { useBots } from '../../stores/bots'
import { useSettings } from '../../stores/settings'
import { errorText, Group, Heading, Row } from '../bot-settings/shared'

function systemName(platform?: string): string {
  if (platform === 'darwin') {
    return 'macOS'
  }

  return platform === 'win32' ? 'Windows' : 'your system'
}

/** This computer or browser: whether it can notify, and a test. */
function ThisDevice() {
  const browser = useBrowserNotifications()
  const [sent, setSent] = useState(false)

  const test = (
    <Button
      onClick={() => {
        sendTestNotification()
        setSent(true)
      }}
      size="sm"
    >
      {sent ? 'Sent' : 'Send a test'}
    </Button>
  )

  if (browser.app) {
    const system = systemName(getBridge()?.platform)
    const settings = systemNotificationSettings()

    // The app cannot see whether its system shows them: macOS hides every
    // one until Hexbot is allowed, and reports each as shown.
    return (
      <Row
        control={
          <>
            {settings ? (
              <Button onClick={settings.open} size="sm">
                Open {settings.name}
              </Button>
            ) : null}
            {test}
          </>
        }
        description={`Shown by ${system}, even with the window closed. If the test does not appear, ${system} is hiding them: allow Hexbot in ${system === 'macOS' ? 'System Settings, Notifications' : `${system}’s notification settings`}.`}
        title="This computer"
      />
    )
  }

  if (browser.insecure) {
    return (
      <Row
        description="Browsers show notifications only for HTTPS pages. Open Hexbot through Hex Connect, use the Hexbot app, or let your phone notify you."
        title="Not available in this browser"
      />
    )
  }

  if (browser.permission === 'unsupported') {
    return <Row description="This browser cannot show notifications." title="This browser" />
  }

  if (browser.permission === 'denied') {
    return (
      <Row
        description="Notifications are blocked for this site. Allow them in the browser’s site settings, then reload."
        title="Blocked in this browser"
      />
    )
  }

  if (browser.askable) {
    return (
      <Row
        control={
          <Button onClick={() => void browser.ask()} size="sm" variant="primary">
            Allow
          </Button>
        }
        description="The browser asks once. Hexbot notifies while this tab is open, even in the background."
        title="This browser"
      />
    )
  }

  return (
    <Row
      control={test}
      description="On while this tab is open, even in the background."
      title="This browser"
    />
  )
}

/** Paired phones that take pushes, and whether Hex Connect can reach them. */
function Phones() {
  const devices = useSettings(state => state.devices)
  const refreshDevices = useSettings(state => state.refreshDevices)
  const navigate = useNavigate()
  const [connect, setConnect] = useState<ConnectStatus | null>(null)

  useEffect(() => {
    void refreshDevices()
    void connectStatus().then(setConnect, () => setConnect(null))
  }, [refreshDevices])

  const phones = devices.filter(device => device.push)

  return (
    <Group
      description="A reply still unread 30 seconds after it finished, or a bot waiting on you, wakes your phones. The push names no bot and holds no message."
      title="Phones"
    >
      {connect && !connect.registered ? (
        <Row
          control={
            <Button
              onClick={() => void navigate({ params: { tab: 'connect' }, to: '/settings/$tab' })}
              size="sm"
            >
              Set up
            </Button>
          }
          description="Phones are woken through Hex Connect."
          title="Hex Connect is off"
        />
      ) : null}
      {phones.length ? (
        phones.map(phone => (
          <Row
            control={<span className="text-[length:var(--text-secondary)] text-muted">On</span>}
            key={phone.id}
            title={phone.name || 'Phone'}
          />
        ))
      ) : (
        <Row
          description="Pair the Hexbot app on your phone and allow notifications when it asks."
          title="No phone takes notifications yet"
        />
      )}
    </Group>
  )
}

/** Notifications about a reply, a card, a stop or a heartbeat message: Hexbot's settings, all devices. */
export function NotificationsSettings(): React.JSX.Element {
  // Each store field alone: a list made in the selector is new on every read.
  const order = useBots(state => state.order)
  const byName = useBots(state => state.byName)

  const bots = useMemo(
    () => order.map(name => byName[name]).filter(bot => bot !== undefined),
    [byName, order]
  )

  const update = useBots(state => state.update)
  const [error, setError] = useState<null | string>(null)

  return (
    <>
      <Heading description="Hexbot notifies you when a bot replies, asks for approval, has a question, stops, or posts from its heartbeat. Never about the chat you have in front of you.">
        Notifications
      </Heading>
      <div className="space-y-8">
        <Group title="This device">
          <ThisDevice />
        </Group>
        <Phones />
        <Group
          description="For every device. A bot you turn off still shows what it did in its chat."
          title="Bots"
        >
          {bots.length ? (
            bots.map(bot => (
              <Row
                control={
                  <Switch
                    aria-label={`Notify me about ${bot.display_name}`}
                    checked={bot.notify !== false}
                    onCheckedChange={checked => {
                      setError(null)
                      update(bot.name, { notify: checked }).catch(cause =>
                        setError(errorText(cause))
                      )
                    }}
                  />
                }
                key={bot.name}
                title={
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Avatar {...botFace(bot)} name={bot.display_name} size="sm" />
                    <span className="truncate">{bot.display_name}</span>
                  </span>
                }
              />
            ))
          ) : (
            <Row title="No bots yet" />
          )}
        </Group>
        {error ? (
          <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </>
  )
}
