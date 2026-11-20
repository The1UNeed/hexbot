import { MessageSquareText, X } from 'lucide-react'

import { type FileComment, fileCommentsActions } from '../../stores/file-comments'
import { useVisuals, visualsActions } from '../../stores/visuals'

/**
 * The comments waiting to go with the next message, above the composer. Each
 * names its file and what it is about; tapping one shows the file's tab.
 */
export function CommentChips({ chat, comments }: { chat: string; comments: FileComment[] }) {
  const tabs = useVisuals(state => state.tabs)

  return (
    <ul aria-label="Comments for the next message" className="mb-2 flex flex-col gap-1.5">
      {comments.map((comment, index) => {
        const toolId = tabs.find(
          tab => 'file' in tab && (tab.file.path ?? tab.title) === (comment.path ?? comment.name)
        )?.toolId

        const about = [comment.where, comment.quote ? `“${comment.quote}”` : '']
          .filter(Boolean)
          .join(' · ')

        return (
          <li
            className="hex-glass hex-bubble flex items-center gap-2 rounded-[16px] py-1.5 pr-1.5 pl-2.5"
            key={comment.id}
          >
            <span
              aria-hidden
              className="grid size-5 shrink-0 place-items-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent tabular-nums"
            >
              {index + 1}
            </span>
            <button
              className="hex-focus min-w-0 flex-1 rounded-[8px] text-left disabled:cursor-default"
              disabled={!toolId}
              onClick={() => toolId && visualsActions().activate(toolId)}
              title={toolId ? `Show ${comment.name}` : undefined}
              type="button"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-[length:var(--text-meta)] text-muted">
                <MessageSquareText className="shrink-0" size={12} />
                <span className="shrink-0 font-medium text-foreground/80">{comment.name}</span>
                {about ? <span className="truncate">{about}</span> : null}
              </span>
              <span className="block truncate text-[length:var(--text-secondary)] text-foreground">
                {comment.note}
              </span>
            </button>
            <button
              aria-label={`Remove comment ${index + 1}`}
              className="hex-focus grid size-6 shrink-0 place-items-center rounded-full text-muted hover:bg-foreground/[0.06] hover:text-foreground"
              onClick={() => fileCommentsActions().remove(chat, comment.id)}
              type="button"
            >
              <X size={13} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}
