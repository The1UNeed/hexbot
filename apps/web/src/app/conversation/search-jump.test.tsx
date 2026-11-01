import { act, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { vi } from 'vitest'

import { searchActions } from '../../stores/search'

import { useSearchJump } from './search-jump'

function Transcript() {
  const viewport = useRef<HTMLDivElement>(null)
  const [rows, setRows] = useState(['b', 'c'])

  useSearchJump(viewport, rows.length)

  return (
    <div ref={viewport}>
      <button onClick={() => setRows(['a', 'b', 'c'])} type="button">
        Load earlier
      </button>
      {rows.map(id => (
        <p data-search-id={id} key={id}>
          {id}
        </p>
      ))}
    </div>
  )
}

describe('useSearchJump', () => {
  it('scrolls to the found message and marks it, once it is shown', () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    searchActions().reset()
    render(<Transcript />)

    act(() => searchActions().jumpTo('a'))
    expect(scroll).not.toHaveBeenCalled()

    // The conversation widens its window; the row lands and is found.
    act(() => screen.getByRole('button', { name: 'Load earlier' }).click())
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(screen.getByText('a')).toHaveClass('hex-search-flash')

    // The same result again scrolls again.
    act(() => searchActions().jumpTo('a'))
    expect(scroll).toHaveBeenCalledTimes(2)

    // Another conversation starts its requests over; the first one still lands.
    act(() => searchActions().reset())
    act(() => searchActions().jumpTo('b'))
    expect(scroll).toHaveBeenCalledTimes(3)
    act(() => searchActions().reset())
    act(() => searchActions().jumpTo('c'))
    expect(scroll).toHaveBeenCalledTimes(4)
  })
})
