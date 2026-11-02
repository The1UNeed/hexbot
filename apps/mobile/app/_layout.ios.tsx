import App from '../App'
import { SplitView } from '../src/shell/SplitView'

/**
 * iOS draws the whole app as SwiftUI's split view: every bot and room in the
 * sidebar, what you choose beside it. See `src/shell/SplitView.tsx`.
 */
export default function RootLayout() {
  return (
    <App>
      <SplitView />
    </App>
  )
}
