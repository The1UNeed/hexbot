import {
  Button,
  Host,
  Menu,
  NavigationDestination,
  NavigationSplitView,
  NavigationStack,
  type NavigationSplitViewVisibility,
  RNHostView,
  Toolbar,
  ToolbarItem
} from '@expo/ui/swift-ui'
import {
  accessibilityLabel,
  disabled,
  ignoreSafeArea,
  onAppear,
  onDisappear,
  navigationBarTitleDisplayMode,
  navigationTitle,
  tint
} from '@expo/ui/swift-ui/modifiers'
import { type ReactElement, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { type AppScreens, useAppScreens } from '../../App'
import {
  AccountFace,
  accountLabel,
  chatActions,
  ChatTitle,
  DaemonSwitch,
  HomeScreen
} from '../screens'
import {
  EmptyState,
  type SheetAction,
  SystemAvoidsKeyboard,
  type Theme,
  useCovered,
  useTheme
} from '../ui'

/**
 * The app on iOS: SwiftUI's split view, like Messages on iPad. The sidebar is
 * Hexbot's chat list; what you choose opens beside it. Where there is no room
 * for two columns (iPhone, iPhone Duo closed) it collapses to the list and
 * pushes what you choose, with native back.
 *
 * Only what iOS has to place is native: the split view and the top bars'
 * items, which it moves into the side rail on iPhone Duo closed and against
 * the fold when it is half open. Everything inside the columns, including
 * the list's grid button and Search, is Hexbot's own.
 */
export function SplitView() {
  const app = useAppScreens()
  const theme = useTheme()
  // Both columns where there is room, like Messages; the sidebar button hides it.
  const [columns, setColumns] = useState<NavigationSplitViewVisibility>('all')
  // Callbacks read the latest state: the native side may hold older copies.
  const latest = useRef(app)
  latest.current = app
  /**
   * Back to the list. Collapsed, SwiftUI folds the detail's stack into its
   * own, and its reports of the column it shows go wrong once a page has
   * been pushed and popped there. So the views beside the list count
   * themselves on and off the screen, and when none is on it for a moment
   * the person went back to the list.
   */
  const onScreen = useRef(new Set<string>())
  const check = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settle = () => {
    if (check.current) clearTimeout(check.current)
    check.current = setTimeout(() => {
      check.current = null
      const now = latest.current
      if (!onScreen.current.size && (now.selected || now.panels.length)) now.select(null)
    }, 400)
  }
  const shown: Shown = (id, on) => {
    if (on) onScreen.current.add(id)
    else onScreen.current.delete(id)
    settle()
  }

  return (
    <Host colorScheme={theme.scheme} ignoreSafeArea="keyboard" style={styles.fill}>
      <NavigationSplitView
        columnVisibility={columns}
        onColumnVisibilityChange={setColumns}
        onPreferredCompactColumnChange={column => {
          if (column === 'sidebar') settle()
        }}
        preferredCompactColumn={app.selected || app.panels.length ? 'detail' : 'sidebar'}
      >
        <NavigationSplitView.Sidebar>
          <Sidebar app={app} />
        </NavigationSplitView.Sidebar>
        <NavigationSplitView.Detail>
          <Detail app={app} onShown={shown} theme={theme} />
        </NavigationSplitView.Detail>
      </NavigationSplitView>
    </Host>
  )
}

/**
 * React Native content in a column. SwiftUI keeps the column clear of the
 * bars, the side rail and the keyboard; a provider here measures from the
 * column, so the screen pads only for what is left, such as the home
 * indicator, and does not lift itself above the keyboard again.
 */
function Column({ children }: { children: ReactElement }) {
  return (
    <RNHostView>
      <SafeAreaProvider style={styles.fill}>
        <SystemAvoidsKeyboard.Provider value>{children}</SystemAvoidsKeyboard.Provider>
      </SafeAreaProvider>
    </RNHostView>
  )
}

function Sidebar({ app }: { app: AppScreens }) {
  const home = app.homeProps
  const canCreate = !!(home.onNewBot || home.onNewRoom)
  const covered = useCovered()

  return (
    <Toolbar
      modifiers={[
        // No title, as in the list's own header: your initials, then +.
        navigationBarTitleDisplayMode('inline'),
        ignoreSafeArea({ edges: 'bottom', regions: covered ? 'all' : 'container' })
      ]}
    >
      <Column>
        <HomeScreen {...home} systemHeader />
      </Column>
      <Toolbar.Content>
        <ToolbarItem placement="topBarLeading">
          {/* A SwiftUI button, so VoiceOver finds it as one; the face is
              only its label and lets touches through to it. */}
          <Button
            modifiers={[accessibilityLabel(accountLabel(home.daemon))]}
            onPress={home.onOpenSettings}
          >
            <RNHostView matchContents>
              <View pointerEvents="none" testID="home-settings">
                <AccountFace daemon={home.daemon} user={home.user} />
              </View>
            </RNHostView>
          </Button>
        </ToolbarItem>
        {home.onSwitchDaemon && home.daemon ? (
          <ToolbarItem placement="principal">
            <RNHostView matchContents>
              <DaemonSwitch daemon={home.daemon} onPress={home.onSwitchDaemon} />
            </RNHostView>
          </ToolbarItem>
        ) : null}
        {canCreate ? (
          <ToolbarItem placement="topBarTrailing">
            <Menu
              label="New"
              modifiers={[accessibilityLabel('New bot or room')]}
              systemImage="plus"
            >
              {home.onNewBot ? (
                <Button label="New bot" onPress={home.onNewBot} systemImage="face.smiling" />
              ) : null}
              {home.onNewRoom ? (
                <Button label="New room" onPress={home.onNewRoom} systemImage="person.2" />
              ) : null}
            </Menu>
          </ToolbarItem>
        ) : null}
      </Toolbar.Content>
    </Toolbar>
  )
}

/**
 * What the sidebar chose, and the pages opened from it. Settings areas, a
 * bot's profile and a room's settings push on the system's stack, as in the
 * iOS Settings app: native back, swipe back, their title and Save in the bar.
 * Opened from the list with nothing beside it, the first page is the root.
 */
function Detail({ app, onShown, theme }: { app: AppScreens; onShown: Shown; theme: Theme }) {
  const hasView = !!app.selected
  // Without a chat, Settings or Bots & jobs, the first page is the root.
  const first = hasView ? 0 : 1
  const pushed = app.panels.slice(first)
  const path = pushed.map((panel, i) => `${i + first}-${panel.kind}`)
  const current = useRef({ first, path })
  current.current = { first, path }

  return (
    <NavigationStack
      onPathChange={next => {
        // Read through a ref: the native side may hold an older copy of this callback.
        const { first: base, path: shown } = current.current
        if (next.length < shown.length) app.keepPanels(base + next.length)
      }}
      path={path}
    >
      <Root app={app} onShown={onShown} theme={theme} />
      {pushed.map((panel, i) => (
        <NavigationDestination key={path[i]} value={path[i]!}>
          {app.renderPanel(i + first, page => (
            <Page {...page} onShown={onShown} />
          ))}
        </NavigationDestination>
      ))}
    </NavigationStack>
  )
}

/**
 * One page on the stack: Hexbot's own content in the column, its title and
 * its confirming action, such as Save, in the system's bar.
 */
function Page({
  action,
  children,
  onShown,
  title
}: {
  title: string
  action?: SheetAction
  children: ReactNode
  onShown: Shown
}) {
  const theme = useTheme()
  const covered = useCovered()
  const visibility = useOnScreen(onShown)

  return (
    <Toolbar
      modifiers={[
        navigationTitle(title),
        navigationBarTitleDisplayMode('inline'),
        ignoreSafeArea({ edges: 'bottom', regions: covered ? 'all' : 'container' }),
        ...visibility
      ]}
    >
      <Column>
        <View style={[styles.fill, { backgroundColor: theme.grouped }]} testID="management-page">
          <ScrollView
            contentContainerStyle={styles.page}
            contentInsetAdjustmentBehavior="automatic"
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.measure}>{children}</View>
          </ScrollView>
        </View>
      </Column>
      <Toolbar.Content>
        {action ? (
          <ToolbarItem placement="topBarTrailing">
            <Button
              label={action.busy && action.busyLabel ? action.busyLabel : action.label}
              modifiers={[
                accessibilityLabel(action.label),
                disabled(!!(action.disabled || action.busy))
              ]}
              onPress={action.onPress}
            />
          </ToolbarItem>
        ) : null}
      </Toolbar.Content>
    </Toolbar>
  )
}

/** What the sidebar chose, with its title and buttons in the system's bar. */
function Root({ app, onShown, theme }: { app: AppScreens; onShown: Shown; theme: Theme }) {
  const covered = useCovered()
  const visibility = useOnScreen(onShown)
  const chat = app.selected && app.selected !== 'settings' && app.selected !== 'library'
  const view =
    app.selected === 'settings'
      ? app.settings
      : app.selected === 'library'
        ? app.library
        : chat
          ? app.chat
          : null

  if (!view) {
    if (app.panels.length)
      return app.renderPanel(0, page => <Page {...page} onShown={onShown} />) as ReactElement
    return (
      <Column>
        <EmptyState
          face={{ name: 'Hexbot' }}
          message="Choose a bot or a room."
          testID="split-empty"
          title="No chat open"
        />
      </Column>
    )
  }

  const props = chat ? app.chatProps : null
  const title = props?.title ?? (app.selected === 'settings' ? 'Settings' : 'Bots & jobs')

  return (
    <Toolbar
      modifiers={[
        navigationTitle(title),
        navigationBarTitleDisplayMode('inline'),
        // Lists and the composer run down to the screen's edge, as in Messages.
        // Under a card or sheet, the column holds still when it brings up the keyboard.
        ignoreSafeArea({ edges: 'bottom', regions: covered ? 'all' : 'container' }),
        ...visibility
      ]}
    >
      <Column>{view as ReactElement}</Column>
      <Toolbar.Content>
        {props ? (
          <ToolbarItem placement="principal">
            <RNHostView matchContents>
              <ChatTitle {...props} />
            </RNHostView>
          </ToolbarItem>
        ) : null}
        {/* Each item is its own toolbar, and the first one applied sits at
            the trailing edge, so they go in reversed: Search ends up first,
            left to right in the bar and top to bottom in the side rail. */}
        {(props ? chatActions(props) : []).reverse().map(action => (
          <ToolbarItem key={action.key} placement="topBarTrailing">
            <Button
              label={action.label}
              modifiers={[
                accessibilityLabel(action.accessibilityLabel),
                ...(action.live ? [tint(theme.info)] : [])
              ]}
              onPress={action.onPress}
              systemImage={action.systemImage}
            />
          </ToolbarItem>
        ))}
      </Toolbar.Content>
    </Toolbar>
  )
}

/** Reports a view coming on screen or leaving it, by an id of its own. */
type Shown = (id: string, on: boolean) => void

/**
 * Modifiers that report this view on and off the screen. A view React takes
 * away is off it too: SwiftUI may not say so once its page is gone.
 */
function useOnScreen(onShown: Shown) {
  const id = useId()
  const report = useRef(onShown)
  report.current = onShown
  useEffect(() => () => report.current(id, false), [id])
  return [onAppear(() => report.current(id, true)), onDisappear(() => report.current(id, false))]
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // A readable measure on iPad and iPhone Duo open, as the desktop's settings pages keep.
  measure: { alignSelf: 'center', maxWidth: 640, width: '100%' },
  page: { paddingBottom: 40, paddingHorizontal: 16, paddingTop: 8 }
})
