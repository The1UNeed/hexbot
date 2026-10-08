import { Ionicons } from '@expo/vector-icons'
import { StyleSheet, Switch, View } from 'react-native'

import {
  Badge,
  Banner,
  BotFace,
  Button,
  ChoiceRow,
  formatAgo,
  formatNextRun,
  Form,
  Group,
  IconButton,
  ModalSheet,
  mono,
  Row,
  Segmented,
  SwitchRow,
  Text,
  useTheme
} from '../ui'
import type { DaemonOverview, DeviceView, JobView, PairingView } from './types'
import { useDraft } from './useDraft'

export type DaemonPage = 'devices' | 'general' | 'jobs'

/** The daemon calls Auto `smart` and Bypass `off`. */
export type ApprovalMode = 'manual' | 'off' | 'smart'

export interface DaemonSheetProps {
  visible: boolean
  onClose: () => void
  initialPage?: DaemonPage
  daemon: DaemonOverview
  error?: string | null

  approvalMode: ApprovalMode
  onApprovalModeChange?: (mode: ApprovalMode) => void
  /** Bypass is for admins only. */
  canBypass?: boolean
  lanEnabled?: boolean
  onLanChange?: (enabled: boolean) => void
  dreamingEnabled?: boolean
  onDreamingChange?: (enabled: boolean) => void

  pairing?: PairingView | null
  onCreatePairing?: () => void
  pairingBusy?: boolean

  devices: DeviceView[]
  onRevokeDevice?: (id: string) => void

  jobs: JobView[]
  onToggleJob?: (id: string, enabled: boolean) => void
  onRunJob?: (id: string) => void
}

const MODES: { key: ApprovalMode; title: string; detail: string }[] = [
  {
    detail:
      'Bots work freely in the workspace. Shell commands run sandboxed with no network, and anything outside the workspace asks first.',
    key: 'smart',
    title: 'Auto'
  },
  { detail: 'Read-only sandbox. Every file change asks.', key: 'manual', title: 'Manual' },
  { detail: 'No prompts and no sandbox.', key: 'off', title: 'Bypass' }
]

/**
 * The daemon's settings, its paired devices and its scheduled jobs. Changes
 * here apply at once, so there is no Save.
 */
export function DaemonSheet(props: DaemonSheetProps) {
  const { daemon, error, initialPage = 'general', onClose, visible } = props
  const [page, setPage] = useDraft<DaemonPage>(initialPage, visible)

  return (
    <ModalSheet
      closeLabel="Done"
      header={
        <Segmented
          onChange={setPage}
          options={[
            { key: 'general', label: 'General' },
            { key: 'devices', label: 'Devices' },
            { key: 'jobs', label: 'Jobs' }
          ]}
          selected={page}
          testID="daemon-sheet-page"
        />
      }
      onClose={onClose}
      testID="daemon-sheet"
      title={daemon.name}
      visible={visible}
    >
      <Form>
        {error ? <Banner message={error} testID="daemon-sheet-error" /> : null}
        {page === 'general' ? <General {...props} /> : null}
        {page === 'devices' ? <Devices {...props} /> : null}
        {page === 'jobs' ? <Jobs {...props} /> : null}
      </Form>
    </ModalSheet>
  )
}

function General({
  approvalMode,
  canBypass,
  daemon,
  dreamingEnabled,
  lanEnabled,
  onApprovalModeChange,
  onDreamingChange,
  onLanChange
}: DaemonSheetProps) {
  return (
    <>
      <Group>
        <Row subtitle={daemon.address} testID="daemon-sheet-address" title="Address" />
        {daemon.version ? (
          <Row subtitle={daemon.version} testID="daemon-sheet-version" title="Version" />
        ) : null}
        {daemon.platform ? (
          <Row subtitle={daemon.platform} testID="daemon-sheet-platform" title="Computer" />
        ) : null}
      </Group>

      <Group
        footer="Bots can still ask before anything risky in Auto and Manual."
        title="Approvals"
      >
        {MODES.filter(mode => mode.key !== 'off' || canBypass || approvalMode === 'off').map(
          mode => (
            <ChoiceRow
              disabled={!onApprovalModeChange || (mode.key === 'off' && !canBypass)}
              key={mode.key}
              onPress={() => onApprovalModeChange?.(mode.key)}
              selected={approvalMode === mode.key}
              subtitle={mode.detail}
              testID={`daemon-sheet-mode-${mode.key}`}
              title={mode.title}
            />
          )
        )}
      </Group>

      {onLanChange || onDreamingChange ? (
        <Group>
          {onLanChange ? (
            <SwitchRow
              onValueChange={onLanChange}
              subtitle="Let apps on this network pair with the daemon."
              testID="daemon-sheet-lan"
              title="Local network"
              value={!!lanEnabled}
            />
          ) : null}
          {onDreamingChange ? (
            <SwitchRow
              onValueChange={onDreamingChange}
              subtitle="Each bot folds the day's conversations into its memory."
              testID="daemon-sheet-dreaming"
              title="Dreaming"
              value={!!dreamingEnabled}
            />
          ) : null}
        </Group>
      ) : null}
    </>
  )
}

function Devices({
  devices,
  onCreatePairing,
  onRevokeDevice,
  pairing,
  pairingBusy
}: DaemonSheetProps) {
  const theme = useTheme()

  return (
    <>
      {onCreatePairing ? (
        <View
          style={[styles.pairing, { backgroundColor: theme.surface }]}
          testID="daemon-sheet-pairing"
        >
          {pairing ? (
            <>
              <Text tone="muted" variant="footnote">
                Pairing code
              </Text>
              <Text selectable style={styles.code} variant="title">
                {pairing.code}
              </Text>
              <Text
                selectable
                numberOfLines={2}
                style={{ fontFamily: mono }}
                tone="muted"
                variant="caption"
              >
                {pairing.link}
              </Text>
              <Text tone="muted" variant="footnote">
                Works once, until{' '}
                {new Date(pairing.expiresAt).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit'
                })}
                .
              </Text>
            </>
          ) : (
            <Text variant="callout">Make a one-time code to pair another phone or computer.</Text>
          )}
          <Button
            busy={pairingBusy}
            busyLabel="Making a code…"
            label={pairing ? 'New code' : 'Pair a device'}
            onPress={onCreatePairing}
            testID="daemon-sheet-pair"
            variant={pairing ? 'secondary' : 'primary'}
          />
        </View>
      ) : null}

      <Group separatorInset={56} title="Paired devices">
        {devices.map(device => (
          <Row
            key={device.id}
            leading={
              <Ionicons
                color={theme.text}
                name={
                  /ios|android|iphone|ipad|mobile/i.test(device.platform)
                    ? 'phone-portrait-outline'
                    : 'desktop-outline'
                }
                size={22}
              />
            }
            subtitle={`${device.platform}, seen ${formatAgo(device.lastSeenAt).toLowerCase()}`}
            testID={`daemon-sheet-device-${device.id}`}
            title={device.name}
            trailing={
              device.current ? (
                <Badge label="This device" tone="accent" />
              ) : onRevokeDevice ? (
                <Button
                  label="Revoke"
                  onPress={() => onRevokeDevice(device.id)}
                  style={styles.revoke}
                  testID={`daemon-sheet-revoke-${device.id}`}
                  variant="destructive"
                />
              ) : null
            }
          />
        ))}
      </Group>
      {devices.length === 0 ? (
        <Text align="center" tone="muted" variant="callout">
          No paired devices.
        </Text>
      ) : null}
    </>
  )
}

function Jobs({ jobs, onRunJob, onToggleJob }: DaemonSheetProps) {
  const theme = useTheme()

  if (jobs.length === 0) {
    return (
      <Text align="center" tone="muted" variant="callout">
        No scheduled jobs. Ask a bot to do something every morning and it shows up here.
      </Text>
    )
  }

  return (
    <Group separatorInset={64}>
      {jobs.map(job => (
        <View key={job.id} style={styles.job} testID={`daemon-sheet-job-${job.id}`}>
          {job.bot ? (
            <BotFace {...job.bot} size={36} />
          ) : (
            <View style={[styles.jobIcon, { backgroundColor: theme.fill }]}>
              <Ionicons color={theme.text} name="alarm-outline" size={20} />
            </View>
          )}
          <View style={styles.jobText}>
            <Text numberOfLines={1} variant="headline">
              {job.name}
            </Text>
            <Text tone="muted" variant="footnote">
              {job.schedule}
              {job.enabled && job.nextRunAt ? `. Next ${formatNextRun(job.nextRunAt)}` : ''}
            </Text>
            {job.lastRunOk === false ? (
              <Text tone="danger" variant="footnote">
                The last run failed.
              </Text>
            ) : null}
          </View>
          {onRunJob ? (
            <IconButton
              accessibilityLabel={`Run ${job.name} now`}
              color={theme.text}
              icon="play-outline"
              iconSize={20}
              onPress={() => onRunJob(job.id)}
              testID={`daemon-sheet-job-run-${job.id}`}
            />
          ) : null}
          <Switch
            accessibilityLabel={`${job.name}, ${job.enabled ? 'on' : 'off'}`}
            disabled={!onToggleJob}
            ios_backgroundColor={theme.fill}
            onValueChange={on => onToggleJob?.(job.id, on)}
            testID={`daemon-sheet-job-toggle-${job.id}`}
            thumbColor="#ffffff"
            trackColor={{ false: theme.hairline, true: theme.success }}
            value={job.enabled}
          />
        </View>
      ))}
    </Group>
  )
}

const styles = StyleSheet.create({
  code: { fontFamily: mono, letterSpacing: 2 },
  job: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minHeight: 64,
    paddingHorizontal: 16,
    paddingVertical: 10
  },
  jobIcon: {
    alignItems: 'center',
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    width: 36
  },
  jobText: { flex: 1, gap: 2 },
  pairing: { borderRadius: 18, gap: 8, padding: 16 },
  revoke: { minHeight: 36, paddingHorizontal: 14 }
})
