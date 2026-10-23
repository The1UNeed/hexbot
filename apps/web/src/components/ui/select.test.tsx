import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { findOption, Select } from './select'

const labels = [
  'Anthropic · Claude Opus 5',
  'DeepSeek · DeepSeek V3',
  'Google · Gemini 2.5 Pro',
  'Ollama · llama3.1',
  'OpenAI · GPT-5',
  'OpenAI · GPT-5 mini',
  'OpenRouter · openai/gpt-5',
  'Perplexity · Sonar'
]

const options = labels.map(label => ({ label, value: label.toLowerCase() }))

const highlighted = () => document.querySelector('[role="option"][data-highlighted]')?.textContent

async function openList() {
  const trigger = screen.getByRole('combobox', { name: 'Model' })

  // A real click focuses the trigger first, so keys typed before the list takes focus land there.
  trigger.focus()
  fireEvent.click(trigger)
  await screen.findAllByRole('option')
}

async function type(text: string) {
  for (const key of text) {
    fireEvent.keyDown(document.activeElement ?? document.body, { key })
    await act(async () => undefined)
  }
}

describe('findOption', () => {
  it('prefers a label that starts with the text over a later word', () => {
    expect(findOption(labels, 'op', 0)).toBe(4)
    expect(findOption(labels, 'opus', 0)).toBe(0)
    expect(findOption(labels, 'gpt-5 m', 0)).toBe(5)
  })

  it('searches from the given option and wraps', () => {
    expect(findOption(labels, 'openai', 5)).toBe(5)
    expect(findOption(labels, 'openai', 6)).toBe(4)
    expect(findOption(labels, 'zz', 0)).toBe(-1)
  })
})

describe('Select typeahead', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps building the search while the user pauses between keys', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(
      <Select
        label="Model"
        onValueChange={() => undefined}
        options={options}
        value={options[0]?.value}
      />
    )
    await openList()

    await type('o')
    expect(highlighted()).toBe('Ollama · llama3.1')

    // Base UI's own typeahead forgot the "o" after 750 ms and jumped to Perplexity on "p".
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    await type('p')
    expect(highlighted()).toBe('OpenAI · GPT-5')

    await type('enr')
    expect(highlighted()).toBe('OpenRouter · openai/gpt-5')
  })

  it('starts a new search when a key matches nothing after the text so far', async () => {
    render(
      <Select
        label="Model"
        onValueChange={() => undefined}
        options={options}
        value={options[0]?.value}
      />
    )
    await openList()

    await type('o')
    await type('g')
    expect(highlighted()).toBe('Google · Gemini 2.5 Pro')

    await type('d')
    expect(highlighted()).toBe('DeepSeek · DeepSeek V3')
  })

  it('moves to the next match when the same letter is pressed again', async () => {
    render(
      <Select
        label="Model"
        onValueChange={() => undefined}
        options={options}
        value={options[0]?.value}
      />
    )
    await openList()

    await type('o')
    expect(highlighted()).toBe('Ollama · llama3.1')
    await type('o')
    expect(highlighted()).toBe('OpenAI · GPT-5')
  })

  it('opens the list from the closed trigger and chooses with Enter', async () => {
    const change = vi.fn()

    render(
      <Select label="Model" onValueChange={change} options={options} value={options[0]?.value} />
    )
    const trigger = screen.getByRole('combobox', { name: 'Model' })

    trigger.focus()
    await type('openr')
    await waitFor(() => expect(highlighted()).toBe('OpenRouter · openai/gpt-5'))
    // Typing only moves the highlight; nothing is chosen until Enter.
    expect(change).not.toHaveBeenCalled()

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Enter' })
    await waitFor(() => expect(change).toHaveBeenCalledWith('openrouter · openai/gpt-5'))
  })
})
