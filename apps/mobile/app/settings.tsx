import { useAppScreens } from '../App'

/** The daemon, what bots are doing, and every settings area. */
export default function Settings() {
  return useAppScreens().settings
}
