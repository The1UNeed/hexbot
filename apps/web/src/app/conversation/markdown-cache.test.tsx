import { cleanup, render } from '@testing-library/react'
import type * as reactMarkdown from 'react-markdown'

import { Markdown } from '.'

const parse = vi.hoisted(() => vi.fn())

vi.mock('react-markdown', async original => {
  const actual = await original<typeof reactMarkdown>()

  return {
    ...actual,
    default: (options: Parameters<typeof actual.default>[0]) => {
      parse(options.children)

      return actual.default(options)
    }
  }
})

afterEach(cleanup)

it('draws a finished message again without parsing it, but keeps no revision still being written', () => {
  render(<Markdown text="A finished **reply**." />)
  cleanup()
  render(<Markdown text="A finished **reply**." />)
  expect(parse).toHaveBeenCalledTimes(1)

  // Each streamed revision is parsed and dropped, so it cannot push finished messages out.
  render(<Markdown streaming text="A reply still" />)
  cleanup()
  render(<Markdown streaming text="A reply still" />)
  expect(parse).toHaveBeenCalledTimes(3)
})
