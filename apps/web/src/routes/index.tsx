import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Home
})

function Home() {
  return (
    <main className="grid min-h-screen place-items-center bg-background text-foreground">
      <section className="rounded-xl border border-border bg-surface px-10 py-8 text-center shadow-sm">
        <h1 className="text-3xl font-semibold">Hexbot</h1>
        <p className="mt-2 text-sm text-muted">Connection: idle</p>
      </section>
    </main>
  )
}
