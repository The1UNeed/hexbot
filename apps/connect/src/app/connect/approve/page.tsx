import { SignInPrompt } from "../../sign-in-prompt";
import { currentClerkUserId } from "@/lib/auth";
import { ApproveForm } from "./approve-form";
export default async function ApprovePage({ searchParams }: { searchParams: Promise<{ code?: string }> }) { const userId = await currentClerkUserId(); const { code } = await searchParams; return <section className="card"><h1>Approve this daemon</h1>{userId ? <><p>Check that this is the code shown by <code>hexbot connect</code>, then approve it.</p><ApproveForm initialCode={code} /></> : <SignInPrompt>Sign in before connecting a daemon to your account.</SignInPrompt>}</section>; }
