import {
  Button,
  Host,
  Menu,
  NavigationSplitView,
  type NavigationSplitViewVisibility,
  RNHostView,
  Toolbar,
  ToolbarItem
} from '@expo/ui/swift-ui'
import {
  accessibilityLabel,
  ignoreSafeArea,
  navigationBarTitleDisplayMode,
  navigationTitle,
  tint
} from '@expo/ui/swift-ui/modifiers'
import { type ReactElement, useState } from 'react'
import { StyleSheet, View } from 'react-native'
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
import { EmptyState, SystemAvoidsKeyboard, type Theme, useCovered, useTheme } from '../ui'

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

  return (
    <Host colorScheme={theme.scheme} ignoreSafeArea="keyboard" style={styles.fill}>
      <NavigationSplitView
        columnVisibility={columns}
        onColumnVisibilityChange={setColumns}
        onPreferredCompactColumnChange={column => {
          if (column === 'sidebar') app.select(null)
        }}
        preferredCompactColumn={app.selected ? 'detail' : 'sidebar'}
      >
        <NavigationSplitView.Sidebar>
          <Sidebar app={app} />
        </NavigationSplitView.Sidebar>
        <NavigationSplitView.Detail>
          <Detail app={app} theme={theme} />
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

/** What the sidebar chose, with its title and buttons in the system's bar. */
function Detail({ app, theme }: { app: AppScreens; theme: Theme }) {
  const covered = useCovered()
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
        ignoreSafeArea({ edges: 'bottom', regions: covered ? 'all' : 'container' })
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

const styles = StyleSheet.create({ fill: { flex: 1 } })
