import { fireEvent, render, screen } from '@testing-library/react'

import { Avatar } from './avatar'
import { Button } from './button'
import { Chip } from './chip'
import { Dialog } from './dialog'
import { Input } from './input'
import { Menu } from './menu'
import { Select } from './select'
import { Spinner } from './spinner'
import { Textarea } from './textarea'
import { Tooltip } from './tooltip'

describe('UI components', () => {
  it('renders Button', () => {
    render(<Button variant="primary">Save</Button>)
    expect(screen.getByRole('button', { name: 'Save' })).toBeVisible()
  })
  it('renders Input', () => {
    render(<Input aria-label="Name" />)
    expect(screen.getByLabelText('Name')).toBeVisible()
  })
  it('renders Textarea', () => {
    render(<Textarea aria-label="Persona" />)
    expect(screen.getByLabelText('Persona')).toBeVisible()
  })
  it('renders a generated face when there is no image', () => {
    const { container } = render(<Avatar name="Ada Lovelace" />)
    expect(screen.getByRole('img', { name: 'Ada Lovelace' })).toBeVisible()
    expect(container.querySelectorAll('ellipse')).toHaveLength(2)
  })
  it('changes the eyes with the mood', () => {
    const { container, rerender } = render(<Avatar mood="idle" name="Ada" />)
    const idle = container.querySelector('ellipse')?.getAttribute('ry')
    rerender(<Avatar mood="sleeping" name="Ada" />)
    expect(container.querySelector('.hex-eyes')).toHaveAttribute('data-mood', 'sleeping')
    expect(container.querySelector('ellipse')?.getAttribute('ry')).not.toBe(idle)
  })
  it('renders Chip', () => {
    render(<Chip>Ready</Chip>)
    expect(screen.getByText('Ready')).toBeVisible()
  })
  it('renders Spinner', () => {
    render(<Spinner />)
    expect(screen.getByRole('status')).toBeVisible()
  })
  it('renders Dialog', () => {
    render(
      <Dialog open title="Settings">
        Body
      </Dialog>
    )
    expect(screen.getByRole('dialog')).toBeVisible()
  })
  it('opens Menu', () => {
    render(<Menu items={[{ label: 'Create' }]} trigger={<button>New</button>} />)
    fireEvent.click(screen.getByRole('button', { name: 'New' }))
    expect(screen.getByText('Create')).toBeVisible()
  })
  it('renders Select', () => {
    render(
      <Select
        label="Model"
        onValueChange={() => undefined}
        options={[{ label: 'Fast', value: 'fast' }]}
        placeholder="Choose"
      />
    )
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeVisible()
  })
  it('shows Tooltip on focus', async () => {
    render(
      <Tooltip content="Help">
        <button>Info</button>
      </Tooltip>
    )
    fireEvent.focus(screen.getByRole('button', { name: 'Info' }))
    expect(await screen.findByText('Help')).toBeVisible()
  })
})
