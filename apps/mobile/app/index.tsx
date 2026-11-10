import { useAppScreens } from '../App'
import { HomeScreen } from '../src/screens'

/** Your conversations, with your initials, + and the grid button and Search. */
export default function Chats() {
  return <HomeScreen {...useAppScreens().homeProps} />
}
