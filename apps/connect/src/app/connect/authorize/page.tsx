import { SignInPrompt } from '../../sign-in-prompt'
import { currentClerkUserId } from '@/lib/auth'
import { AuthorizeForm } from './authorize-form'

export default async function AuthorizePage({
  searchParams
}: {
  searchParams: Promise<{ state?: string; device?: string }>
}) {
  const userId = await currentClerkUserId()
  const { state, device } = await searchParams
  if (!userId)
    return (
      <section className="card">
        <h1>Sign in to Hex Connect</h1>
        <SignInPrompt>Sign in to connect this app to your daemons.</SignInPrompt>
      </section>
    )
  if (!state || !device || state.length > 256 || device.length > 100)
    return (
      <section className="card">
        <h1>Invalid request</h1>
        <p className="error">The authorization link is missing a valid state or device name.</p>
      </section>
    )
  return (
    <section className="card">
      <h1>Connect Hexbot</h1>
      <p>Authorize {device} to connect to your daemons.</p>
      <AuthorizeForm device={device} state={state} />
    </section>
  )
}
