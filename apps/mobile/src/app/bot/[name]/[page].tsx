import { Redirect, useLocalSearchParams } from 'expo-router'

/** An unknown bot page (an old link): land on the bot sheet itself. */
export default function UnknownPage() {
  const { name } = useLocalSearchParams<{ name: string }>()

  return <Redirect href={{ params: { name }, pathname: '/bot/[name]' }} />
}
