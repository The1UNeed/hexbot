import { fireEvent, render, screen } from '@testing-library/react'

import { Button } from './button'

it('blocks repeated submissions while busy even when validation allows the action', () => {
  const onClick = vi.fn()
  render(<Button busy disabled={false} onClick={onClick}>Connect</Button>)
  const button = screen.getByRole('button', { name: /Connect/ })
  expect(button).toBeDisabled()
  fireEvent.click(button)
  expect(onClick).not.toHaveBeenCalled()
})
