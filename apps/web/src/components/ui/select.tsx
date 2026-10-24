import { Select as BaseSelect } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'
import {
  type ComponentProps,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  useLayoutEffect,
  useRef,
  useState
} from 'react'

import { cn } from '../../lib/cn'

import { fieldClass } from './input'

export interface SelectOption {
  label: string
  value: string
}

export interface SelectProps {
  disabled?: boolean
  label?: string
  onValueChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  value?: string
}

/** Keys that move the highlight themselves; pressing one ends the typed search. */
const NAVIGATION_KEYS = new Set(['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp'])

/**
 * The option a typed search lands on, searching from `from` and wrapping. A label that starts
 * with the text wins over one where a later word does, so "op" finds "OpenAI" before
 * "Anthropic · Claude Opus", and "opus" still finds the latter.
 */
export function findOption(labels: string[], text: string, from: number): number {
  const query = text.toLowerCase()

  const ranks = labels.map(label => {
    const lower = label.toLowerCase()

    if (lower.startsWith(query)) {
      return 0
    }

    // A later word: the text follows a space, a dot, a dash, or other punctuation.
    for (let index = lower.indexOf(query); index > 0; index = lower.indexOf(query, index + 1)) {
      if (!/[\p{L}\p{N}]/u.test(lower.charAt(index - 1))) {
        return 1
      }
    }

    return -1
  })

  for (const rank of [0, 1]) {
    for (let step = 0; step < ranks.length; step++) {
      const index = (from + step) % ranks.length

      if (ranks[index] === rank) {
        return index
      }
    }
  }

  return -1
}

/** An option that says when Base UI's highlight leaves it. */
function Option({
  highlighted,
  onUnhighlight,
  ...props
}: ComponentProps<'div'> & { highlighted: boolean; onUnhighlight: () => void }) {
  const was = useRef(highlighted)

  useLayoutEffect(() => {
    if (was.current && !highlighted) {
      onUnhighlight()
    }

    was.current = highlighted
  })

  return <div {...props} />
}

export function Select({
  disabled,
  label,
  onValueChange,
  options,
  placeholder,
  value
}: SelectProps) {
  const [open, setOpen] = useState(false)
  const popupRef = useRef<HTMLDivElement>(null)

  // What has been typed since the list opened, the option that search started after, and the
  // option it found. Base UI's own typeahead forgets the text after 750 ms and drops keys typed
  // before the items mount; this one keeps the text until the list closes or the arrows take
  // over. Options are kept by value, so a list that reorders while the user types never moves
  // the search onto a different option.
  const search = useRef<{
    after: string | null
    match: string | null
    space: boolean
    text: string
  }>({ after: null, match: null, space: false, text: '' })

  const pointer = useRef({ x: 0, y: 0 })

  const items = () =>
    Array.from(popupRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])

  const indexOf = (option: string | null) => options.findIndex(item => item.value === option)

  const reset = () => {
    search.current = { after: null, match: null, space: false, text: '' }
  }

  // Base UI highlights an option when it takes focus, and keeps the highlight by position. When
  // the options reorder under an open list, the option the search found can keep focus while
  // the highlight stays at its old position, so focus leaves it and comes back.
  const highlightMatch = () => {
    const item = items()[indexOf(search.current.match)]

    if (!item || (document.activeElement === item && item.hasAttribute('data-highlighted'))) {
      return
    }

    if (document.activeElement === item) {
      popupRef.current?.focus({ preventScroll: true })
    }

    item.focus({ preventScroll: true })
    item.scrollIntoView?.({ block: 'nearest' })
  }

  const changeOpen = (next: boolean) => {
    setOpen(next)

    if (!next) {
      reset()
    }
  }

  // Runs before Base UI sees the key, on the trigger and in the list.
  const onKeyDownCapture = (event: KeyboardEvent<HTMLElement>) => {
    const { key } = event

    if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) {
      return
    }

    if (NAVIGATION_KEYS.has(key)) {
      reset()

      return
    }

    const current = search.current
    let text: string

    if (key === 'Backspace' && current.text) {
      text = current.text.slice(0, -1)
    } else if (key.length === 1 && (key !== ' ' || current.text)) {
      text = current.text + key
    } else {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    current.space = key === ' '

    const labels = options.map(option => option.label)

    // A new search starts after the highlighted option, or the chosen one while closed.
    const after = () => {
      const highlighted = open
        ? items().findIndex(item => item.hasAttribute('data-highlighted'))
        : -1

      return highlighted === -1 ? (value ?? null) : (options[highlighted]?.value ?? null)
    }

    if (!current.text) {
      current.after = after()
    }

    let match = text ? findOption(labels, text, indexOf(current.after) + 1) : indexOf(current.match)

    // A key that matches nothing together with what came before starts a new search, so
    // typing "o" then "g" lands on Google and pressing "o" twice moves to the next "O".
    if (match === -1 && current.text && key.length === 1 && key !== ' ') {
      const from = after()

      match = findOption(labels, key, indexOf(from) + 1)

      if (match !== -1) {
        current.after = from
        text = key
      }
    }

    if (match === -1) {
      return
    }

    current.text = text
    current.match = options[match]?.value ?? null

    if (open) {
      highlightMatch()
    } else {
      setOpen(true)
    }
  }

  // Space continues the search; keep it from choosing the highlighted option on key up.
  const onKeyUpCapture = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === ' ' && search.current.space) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  // Base UI focuses the chosen option once the list has opened, and keys typed during that
  // land before it; hand focus back to what the search found. If that option has left the
  // list, the search ends and the highlight stays where Base UI put it.
  const onPopupFocus = (event: FocusEvent<HTMLElement>) => {
    const { match } = search.current

    if (match === null) {
      return
    }

    const item = items()[indexOf(match)]

    if (!item) {
      reset()
    } else if (event.target !== item) {
      highlightMatch()
    }
  }

  // Moving the mouse or turning the wheel hands the highlight back to the pointer. A list that
  // scrolls to the found option under a still pointer also reports a move, so only a real change
  // of position counts there.
  const onPopupPointerMove = (event: PointerEvent<HTMLElement>) => {
    const moved = event.clientX !== pointer.current.x || event.clientY !== pointer.current.y

    pointer.current = { x: event.clientX, y: event.clientY }

    if (moved) {
      reset()
    }
  }

  return (
    <BaseSelect.Root
      disabled={disabled}
      onOpenChange={changeOpen}
      onValueChange={next => next && onValueChange(next)}
      open={open}
      value={value ?? null}
    >
      <BaseSelect.Trigger
        aria-label={label}
        className={cn(
          fieldClass,
          'flex h-[36px] w-full min-w-0 items-center justify-between gap-2 px-3 text-left'
        )}
        onKeyDownCapture={onKeyDownCapture}
        onKeyUpCapture={onKeyUpCapture}
      >
        <BaseSelect.Value className="min-w-0 truncate">
          {selected =>
            selected ? options.find(item => item.value === selected)?.label : placeholder
          }
        </BaseSelect.Value>
        <BaseSelect.Icon className="shrink-0 text-muted">
          <ChevronDown aria-hidden size={15} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          alignItemWithTrigger={false}
          className="z-50 outline-none"
          sideOffset={6}
        >
          <BaseSelect.Popup
            className="hex-glass-strong hex-menu-in max-h-80 min-w-[var(--anchor-width)] overflow-auto rounded-[14px] p-1 text-foreground outline-none"
            onFocus={onPopupFocus}
            onKeyDownCapture={onKeyDownCapture}
            onKeyUpCapture={onKeyUpCapture}
            onPointerMove={onPopupPointerMove}
            onWheel={reset}
            ref={popupRef}
          >
            <BaseSelect.List>
              {options.map(option => (
                <BaseSelect.Item
                  className="flex cursor-default items-center gap-2 rounded-[10px] py-2 pr-3 pl-2.5 text-[length:var(--text-secondary)] outline-none data-[highlighted]:bg-foreground/[0.07]"
                  key={option.value}
                  render={(props, state) => (
                    <Option
                      {...props}
                      highlighted={state.highlighted}
                      onUnhighlight={() => {
                        if (search.current.match === option.value) {
                          highlightMatch()
                        }
                      }}
                    />
                  )}
                  value={option.value}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    <BaseSelect.ItemIndicator>
                      <Check aria-hidden size={14} />
                    </BaseSelect.ItemIndicator>
                  </span>
                  <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  )
}
