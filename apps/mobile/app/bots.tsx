import { useAppScreens } from '../App'

/** Every bot's profile, scheduled jobs, and all rooms. */
export default function Bots() {
  return useAppScreens().library
}
