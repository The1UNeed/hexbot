import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { readDocx } from '../../../lib/office/docx'
import { dataUrlOf, OfficePackage } from '../../../lib/office/package'
import { readPptx } from '../../../lib/office/pptx'
import { docx, pptx } from '../../../lib/office/test-fixtures'
import { holdCopy } from '../../../stores/page-copies'

import { DocxView, POWERPOINT, PptxView, WORD } from './office-view'

function props(dataUrl: string) {
  const saves: string[] = []

  return {
    flushRef: { current: null as (() => Promise<boolean>) | null },
    props: {
      editable: true,
      file: {
        data_url: dataUrl,
        mime: '',
        modified: 0,
        name: 'f',
        path: '/w/f',
        size: 0,
        version: 'v1'
      },
      name: 'f',
      onFollow: vi.fn(),
      onSave: vi.fn(async (next: string) => {
        saves.push(next)

        return `v${saves.length + 1}`
      })
    },
    saves
  }
}

/** Puts the caret `offset` characters into the first text of `node`. */
function caretAt(node: Element, offset: number) {
  const text = node.querySelector('span')!.firstChild!
  const range = document.createRange()
  range.setStart(text, offset)
  range.collapse(true)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
}

describe('a Word file beside the chat', () => {
  it('splits a paragraph with Enter without writing the old text back on blur', async () => {
    const { flushRef, props: view, saves } = props(dataUrlOf(docx().save(), WORD))

    render(<DocxView {...view} flushRef={flushRef} />)
    const paragraph = (await screen.findByText('Bold')).closest('[data-where]') as HTMLElement

    paragraph.focus()
    caretAt(paragraph, 4)
    fireEvent.keyDown(paragraph, { key: 'Enter' })
    fireEvent.blur(paragraph)
    await act(async () => {
      expect(await flushRef.current!()).toBe(true)
    })

    const saved = readDocx(OfficePackage.fromDataUrl(saves.at(-1)!))!

    const texts = saved.blocks.map(block =>
      block.kind === 'paragraph' ? block.views.map(view => view.text).join('') : 'table'
    )

    expect(texts.slice(0, 4)).toEqual(['Results', 'Bold', ' and plain.', 'First'])
  })
})

describe('a Word paragraph split over selected words', () => {
  it('drops the selected words', async () => {
    const { flushRef, props: view, saves } = props(dataUrlOf(docx().save(), WORD))

    render(<DocxView {...view} flushRef={flushRef} />)
    const paragraph = (await screen.findByText('Bold')).closest('[data-where]') as HTMLElement
    paragraph.focus()
    const text = paragraph.querySelectorAll('span')[1]!.firstChild!
    const range = document.createRange()

    // "and " in "and plain."
    range.setStart(text, 0)
    range.setEnd(text, 4)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    fireEvent.keyDown(paragraph, { key: 'Enter' })
    fireEvent.blur(paragraph)
    await act(async () => {
      expect(await flushRef.current!()).toBe(true)
    })

    const texts = readDocx(OfficePackage.fromDataUrl(saves.at(-1)!))!.blocks.map(block =>
      block.kind === 'paragraph' ? block.views.map(item => item.text).join('') : 'table'
    )

    expect(texts.slice(1, 3)).toEqual(['Bold ', 'plain.'])
  })
})

describe('a Word paragraph left before its text went back into the file', () => {
  it('saves what was typed when the view goes', async () => {
    const { flushRef, props: view, saves } = props(dataUrlOf(docx().save(), WORD))
    const shown = render(<DocxView {...view} flushRef={flushRef} />)
    const paragraph = (await screen.findByText('Bold')).closest('[data-where]') as HTMLElement

    paragraph.querySelectorAll('span')[1]!.textContent = 'and typed.'
    fireEvent.input(paragraph)
    // Leaving the chat closes the tab at once: no blur, no pause.
    shown.unmount()
    await act(async () => {})

    const saved = readDocx(OfficePackage.fromDataUrl(saves.at(-1)!))!
    const second = saved.blocks[1]!

    expect(second.kind === 'paragraph' && second.views.map(item => item.text).join('')).toBe(
      'Bold and typed.'
    )
  })
})

describe('a Word file only this page holds', () => {
  it('opens from the page copy behind its object URL', async () => {
    const created = vi.fn(() => 'blob:test-launch-plan')

    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() })
    const url = holdCopy(new Blob([docx().save() as BlobPart], { type: WORD }))
    const { flushRef, props: view } = props(url)

    render(<DocxView {...view} flushRef={flushRef} />)

    expect(await screen.findByText('Bold')).toBeInTheDocument()
  })
})

describe('a PowerPoint file beside the chat', () => {
  it('keeps the box being typed in when its text goes back into the file', async () => {
    const { flushRef, props: view, saves } = props(dataUrlOf(pptx().save(), POWERPOINT))

    // The slides are drawn once the panel has a width.
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)

    render(<PptxView {...view} flushRef={flushRef} />)
    width.mockRestore()
    const box = (await screen.findByText('Quarterly')).closest('[contenteditable]') as HTMLElement

    box.querySelector('span')!.textContent = 'Yearly'
    fireEvent.blur(box)
    await act(async () => {
      expect(await flushRef.current!()).toBe(true)
    })

    expect(box.isConnected).toBe(true)
    const slide = readPptx(OfficePackage.fromDataUrl(saves.at(-1)!))!.slides[0]!

    expect(slide.shapes[0]!.paragraphs![0]!.views[0]!.text).toBe('Yearly')
  })
})
