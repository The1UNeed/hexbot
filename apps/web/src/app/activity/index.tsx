import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Avatar } from '../../components/ui/avatar'
import { activityList, activityPairs } from '../../lib/api'
import { toMillis } from '../../lib/time'
import type { ActivityPair, BotMessage } from '../../lib/types'
import { useBots } from '../../stores/bots'

export function ActivityView() {
  const [pairs, setPairs] = useState<ActivityPair[]>([])
  const [selected, setSelected] = useState<ActivityPair | null>(null)
  const [messages, setMessages] = useState<BotMessage[]>([])
  const [error, setError] = useState<string | null>(null)
  const bots = useBots(state => state.byName)

  useEffect(() => {
    void activityPairs()
      .then(result => setPairs(result.pairs))
      .catch(reason => setError(String(reason)))
  }, [])

  const choose = (pair: ActivityPair) => {
    setSelected(pair)
    void activityList({ from: pair.from_bot, to: pair.to_bot })
      .then(result => setMessages(result.messages))
      .catch(reason => setError(String(reason)))
  }

  return (
    <div className="flex h-screen min-h-0 bg-background">
      <section className="min-w-0 flex-1 overflow-auto p-6">
        <header className="mb-5">
          <h2 className="text-[length:var(--text-title)] font-semibold">Bot activity</h2>
          <p className="mt-1 text-muted">Messages bots have sent to each other.</p>
        </header>
        {error ? (
          <p className="text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-border text-[length:var(--text-secondary)] text-muted">
              <th className="py-2 font-medium">Pair</th>
              <th className="py-2 font-medium">Messages</th>
              <th className="py-2 font-medium">Last activity</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map(pair => (
              <tr
                className="cursor-pointer border-b border-border hover:bg-surface-2"
                key={`${pair.from_bot}:${pair.to_bot}`}
                onClick={() => choose(pair)}
              >
                <td className="py-3">
                  <span className="flex items-center gap-2">
                    <Avatar name={bots[pair.from_bot]?.display_name ?? pair.from_bot} size="sm" />
                    {bots[pair.from_bot]?.display_name ?? pair.from_bot}
                    <ArrowRight size={13} />
                    <Avatar name={bots[pair.to_bot]?.display_name ?? pair.to_bot} size="sm" />
                    {bots[pair.to_bot]?.display_name ?? pair.to_bot}
                  </span>
                </td>
                <td className="py-3">{pair.count}</td>
                <td className="py-3 text-muted">
                  {new Date(toMillis(pair.last_at)).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {selected ? (
        <aside className="w-80 overflow-auto border-l border-border bg-surface p-4">
          <h3 className="mb-3 font-semibold">
            {selected.from_bot} to {selected.to_bot}
          </h3>
          <ul className="divide-y divide-border">
            {messages.map(message => (
              <li className="py-3" key={message.id}>
                <Link
                  className="block hover:text-accent"
                  params={{ bot: message.to_bot, section: message.section_id }}
                  to="/b/$bot/s/$section"
                >
                  <p className="line-clamp-3 whitespace-pre-wrap">{message.text}</p>
                  <time className="mt-1 block text-[length:var(--text-meta)] text-muted">
                    {new Date(toMillis(message.created_at)).toLocaleString()}
                  </time>
                </Link>
              </li>
            ))}
          </ul>
        </aside>
      ) : null}
    </div>
  )
}
