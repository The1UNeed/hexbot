import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import {
  type DocxParagraph,
  joinParagraph,
  readDocx,
  setParagraphText,
  splitParagraph
} from './docx'
import { bytesOfDataUrl, dataUrlOf, OfficePackage, resolvePath } from './package'
import { readPptx, setSlideText } from './pptx'
import { writeRuns } from './runs'
import { docx, pack, pptx, xlsx } from './test-fixtures'
import { cellLocked, cellSource, dateToSerial, readXlsx, serialToDate, setCells } from './xlsx'

/** A saved package opened again, as the next read would. */
const reopen = (pkg: OfficePackage) => new OfficePackage(pkg.save())

const part = (pkg: OfficePackage, path: string) => strFromU8(unzipSync(pkg.save())[path]!)

describe('a Word file', () => {
  it('reads headings, runs, lists, tables and the page', () => {
    const doc = readDocx(docx())!

    expect(doc.page).toEqual({ margin: 96, width: 816 })
    const [heading, body, list, table] = doc.blocks

    expect(heading).toMatchObject({ heading: 1, kind: 'paragraph', where: 'the heading “Results”' })
    expect(body).toMatchObject({ where: 'paragraph 2, under “Results”' })
    expect(body!.kind === 'paragraph' && body!.views).toEqual([
      expect.objectContaining({ bold: true, text: 'Bold ' }),
      expect.objectContaining({ bold: false, text: 'and plain.' })
    ])
    expect(list).toMatchObject({ list: { level: 0, ordered: true } })
    expect(table!.kind === 'table' && table!.rows[0]![0]![0]!.views[0]!.text).toBe('Cell')
  })

  it('edits text in its runs and keeps every other part as it was', () => {
    const pkg = docx()
    const body = readDocx(pkg)!.blocks[1]!

    if (body.kind !== 'paragraph') {
      throw new Error('expected a paragraph')
    }

    setParagraphText(pkg, body, ['Very bold ', 'and plain.'])
    const again = reopen(pkg)
    const views = (readDocx(again)!.blocks[1] as typeof body).views

    expect(views.map(view => [view.text, view.bold])).toEqual([
      ['Very bold ', true],
      ['and plain.', false]
    ])
    expect(part(pkg, 'word/styles.xml')).toBe('<keep-me-exactly/>')
    expect(part(pkg, 'word/document.xml')).toMatch(/^<\?xml/)
  })

  it('splits a paragraph at the caret and joins it back', () => {
    const pkg = docx()
    const body = readDocx(pkg)!.blocks[1]!

    if (body.kind !== 'paragraph') {
      throw new Error('expected a paragraph')
    }

    splitParagraph(pkg, body, ['Bold ', 'and'], ' plain.', 1)
    let blocks = readDocx(pkg)!.blocks

    const text = (index: number) =>
      (blocks[index] as typeof body).views.map(view => view.text).join('')

    expect([text(1), text(2), text(3)]).toEqual(['Bold and', ' plain.', 'First'])

    joinParagraph(pkg, blocks[1] as typeof body, blocks[2] as typeof body)
    blocks = readDocx(reopen(pkg))!.blocks
    expect(text(1)).toBe('Bold and plain.')
    expect((blocks[1] as typeof body).views[0]!.bold).toBe(true)
  })
})

describe('a Word paragraph typed into while empty', () => {
  it('joins the paragraph before it with the text just typed', () => {
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

    const pkg = pack({
      'word/document.xml': `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Start</w:t></w:r></w:p><w:p/></w:body></w:document>`
    })

    const [first, empty] = readDocx(pkg)!.blocks as DocxParagraph[]

    setParagraphText(pkg, empty!, [' and more'])
    // The join reads the paragraph as it is, not the runs it was read with.
    joinParagraph(pkg, first!, empty!)

    const blocks = readDocx(reopen(pkg))!.blocks as DocxParagraph[]

    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.views.map(view => view.text).join('')).toBe('Start and more')
  })
})

describe('an Excel file', () => {
  it('shows strings, numbers, dates, percents and formula values', () => {
    const pkg = xlsx()
    const sheet = readXlsx(pkg)!.sheets[0]!

    expect(sheet.name).toBe('Parts')
    expect(sheet.rows).toEqual([
      ['Pin', 'Use'],
      ['2.5', '2024-03-01', '25%'],
      ['5', '6']
    ])
    expect(cellSource(pkg, sheet, 2, 0)).toBe('=A2*2')
    expect(cellLocked(pkg, sheet, 2, 1)).toMatch(/share this formula/)
  })

  it('sets text, numbers, dates and formulas, keeping styles, and recalculates on open', () => {
    const pkg = xlsx()
    const sheet = readXlsx(pkg)!.sheets[0]!

    setCells(pkg, sheet, [
      { col: 0, row: 0, value: 'Part' },
      { col: 1, row: 1, value: '2024-04-02' },
      { col: 0, row: 2, value: '=A2*3' },
      { col: 3, row: 4, value: '42' },
      { col: 2, row: 1, value: '30%' }
    ])

    const again = reopen(pkg)
    const read = readXlsx(again)!.sheets[0]!

    expect(read.rows[0]![0]).toBe('Part')
    expect(read.rows[1]![1]).toBe('2024-04-02')
    expect(read.rows[2]![0]).toBe('=A2*3')
    expect(read.rows[4]![3]).toBe('42')
    expect(read.rows[1]![2]).toBe('30%')
    const xml = part(pkg, 'xl/worksheets/sheet1.xml')

    expect(xml).toContain('<c r="B2" s="1"><v>45384</v></c>')
    expect(xml).toContain('<c r="C2" s="2"><v>0.3</v></c>')
    expect(xml).toContain('<dimension ref="A1:D5"/>')
    expect(part(pkg, 'xl/workbook.xml')).toContain('fullCalcOnLoad="1"')
    expect(unzipSync(pkg.save())['xl/calcChain.xml']).toBeUndefined()
    expect(part(pkg, '[Content_Types].xml')).not.toContain('calcChain')
    expect(part(pkg, 'xl/_rels/workbook.xml.rels')).not.toContain('calcChain')
  })

  it('converts dates both ways', () => {
    expect(serialToDate(45352)).toBe('2024-03-01')
    expect(serialToDate(45352.5)).toBe('2024-03-01 12:00')
    expect(dateToSerial('2024-03-01')).toBe(45352)
    expect(dateToSerial('March')).toBeNull()
    // A workbook that counts from 1904 is 1,462 days behind.
    expect(serialToDate(43890, true)).toBe('2024-03-01')
    expect(dateToSerial('2024-03-01', true)).toBe(43890)
  })
})

describe('a PowerPoint file', () => {
  it('places shapes, takes placeholders from the layout and colours from the theme', () => {
    const deck = readPptx(pptx())!

    expect([deck.width, deck.height]).toEqual([9144000, 5143500])
    const slide = deck.slides[0]!
    const [title, second, ellipse] = slide.shapes

    expect(slide.background).toBe('#FAFAFA')
    expect(title).toMatchObject({ h: 400, kind: 'text', w: 3000, x: 100, y: 200 })
    expect(title!.paragraphs![0]!.views).toEqual([
      expect.objectContaining({ bold: true, color: '#4472C4', size: 44, text: 'Quarterly' }),
      { text: '\n' },
      expect.objectContaining({ text: 'review' })
    ])
    // Two layout placeholders of one type: the slide's takes the one with its index.
    expect(second).toMatchObject({ h: 500, w: 500, x: 2000, y: 2000 })
    expect(ellipse).toMatchObject({ anchor: 'middle', fill: '#FF0000', round: 'ellipse' })
  })

  it('edits text around a line break and into an empty paragraph', () => {
    const pkg = pptx()
    const slide = readPptx(pkg)!.slides[0]!
    const [title, , ellipse] = slide.shapes

    setSlideText(pkg, slide, title!.paragraphs![0]!, ['Yearly', '\n', 'review'])
    setSlideText(pkg, slide, ellipse!.paragraphs![0]!, ['Note'])
    const again = readPptx(reopen(pkg))!.slides[0]!

    expect(again.shapes[0]!.paragraphs![0]!.views.map(view => view.text)).toEqual([
      'Yearly',
      '\n',
      'review'
    ])
    expect(again.shapes[2]!.paragraphs![0]!.views).toEqual([
      expect.objectContaining({ size: 12, text: 'Note' })
    ])
  })
})

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'

describe('runs', () => {
  it('put merged text in a text run, keeping a PowerPoint line break', () => {
    const doc = new DOMParser().parseFromString(
      `<a:p xmlns:a="${A}"><a:br/><a:r><a:t>old</a:t></a:r></a:p>`,
      'application/xml'
    )

    const runs = Array.from(doc.documentElement.children)

    writeRuns(runs, A, ['\nnew'])

    expect(new XMLSerializer().serializeToString(doc)).toContain('<a:br/><a:r><a:t>new</a:t></a:r>')
  })
})

describe('the package', () => {
  it('resolves relationship targets and round-trips data URLs', () => {
    expect(resolvePath('ppt/slides/', '../media/a.png')).toBe('ppt/media/a.png')
    expect(resolvePath('xl/', '/xl/worksheets/s.xml')).toBe('xl/worksheets/s.xml')
    const bytes = new Uint8Array([80, 75, 3, 4, 255])

    expect(Array.from(bytesOfDataUrl(dataUrlOf(bytes, 'application/zip')))).toEqual(
      Array.from(bytes)
    )
  })
})
