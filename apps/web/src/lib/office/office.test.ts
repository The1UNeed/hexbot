import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { joinParagraph, readDocx, setParagraphText, splitParagraph } from './docx'
import { bytesOfDataUrl, dataUrlOf, OfficePackage, resolvePath } from './package'
import { readPptx, setSlideText } from './pptx'
import { cellLocked, cellSource, dateToSerial, readXlsx, serialToDate, setCells } from './xlsx'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships'

const pack = (files: Record<string, string>) =>
  new OfficePackage(
    zipSync(
      Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new Uint8Array(strToU8(v))]))
    )
  )

/** A saved package opened again, as the next read would. */
const reopen = (pkg: OfficePackage) => new OfficePackage(pkg.save())

const part = (pkg: OfficePackage, path: string) => strFromU8(unzipSync(pkg.save())[path]!)

function docx() {
  return pack({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Results</w:t></w:r></w:p>
      <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold </w:t></w:r><w:r><w:t xml:space="preserve">and plain.</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      <w:sectPr><w:pgSz w:w="12240"/><w:pgMar w:left="1440"/></w:sectPr>
    </w:body></w:document>`,
    'word/numbering.xml': `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
    'word/styles.xml': '<keep-me-exactly/>'
  })
}

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

    if (body.kind !== 'paragraph') {throw new Error('expected a paragraph')}
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

    if (body.kind !== 'paragraph') {throw new Error('expected a paragraph')}
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

function xlsx() {
  return pack({
    '[Content_Types].xml': `<Types xmlns="x"><Override PartName="/xl/calcChain.xml"/></Types>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${REL}"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="ws"/><Relationship Id="rId2" Target="calcChain.xml" Type="calc"/></Relationships>`,
    'xl/calcChain.xml': '<calcChain/>',
    'xl/sharedStrings.xml': `<sst xmlns="${S}"><si><t>Pin</t></si><si><r><t>Us</t></r><r><t>e</t></r></si></sst>`,
    'xl/styles.xml': `<styleSheet xmlns="${S}"><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="10"/></cellXfs></styleSheet>`,
    'xl/workbook.xml': `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="Parts" r:id="rId1"/></sheets></workbook>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${S}"><dimension ref="A1:C3"/><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2"><v>2.5</v></c><c r="B2" s="1"><v>45352</v></c><c r="C2" s="2"><v>0.25</v></c></row>
      <row r="3"><c r="A3"><f>A2*2</f><v>5</v></c><c r="B3"><f t="shared" ref="B3:B4" si="0">A3+1</f><v>6</v></c></row>
    </sheetData></worksheet>`
  })
}

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
      { col: 3, row: 4, value: '42' }
    ])

    const again = reopen(pkg)
    const read = readXlsx(again)!.sheets[0]!

    expect(read.rows[0]![0]).toBe('Part')
    expect(read.rows[1]![1]).toBe('2024-04-02')
    expect(read.rows[2]![0]).toBe('=A2*3')
    expect(read.rows[4]![3]).toBe('42')
    const xml = part(pkg, 'xl/worksheets/sheet1.xml')

    expect(xml).toContain('<c r="B2" s="1"><v>45384</v></c>')
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
  })
})

function pptx() {
  return pack({
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${REL}"><Relationship Id="rId2" Target="slides/slide1.xml" Type="slide"/></Relationships>`,
    'ppt/presentation.xml': `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': `<Relationships xmlns="${REL}"><Relationship Id="rId1" Target="../slideMasters/slideMaster1.xml" Type="x/slideMaster"/></Relationships>`,
    'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="3000" cy="400"/></a:xfrm></p:spPr></p:sp></p:spTree></p:cSld></p:sldLayout>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': `<Relationships xmlns="${REL}"><Relationship Id="rId1" Target="../theme/theme1.xml" Type="x/theme"/></Relationships>`,
    'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></p:bgPr></p:bg><p:spTree/></p:cSld><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle></p:txStyles></p:sldMaster>`,
    'ppt/slides/_rels/slide1.xml.rels': `<Relationships xmlns="${REL}"><Relationship Id="rId1" Target="../slideLayouts/slideLayout1.xml" Type="x/slideLayout"/></Relationships>`,
    'ppt/slides/slide1.xml': `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree>
      <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:rPr b="1"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:rPr><a:t>Quarterly</a:t></a:r><a:br/><a:r><a:t>review</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr/><p:spPr><a:xfrm><a:off x="10" y="20"/><a:ext cx="30" cy="40"/></a:xfrm><a:prstGeom prst="ellipse"/><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:p><a:endParaRPr sz="1200"/></a:p></p:txBody></p:sp>
    </p:spTree></p:cSld></p:sld>`,
    'ppt/theme/theme1.xml': `<a:theme xmlns:a="${A}"><a:themeElements><a:clrScheme><a:lt1><a:srgbClr val="FAFAFA"/></a:lt1><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme></a:themeElements></a:theme>`
  })
}

describe('a PowerPoint file', () => {
  it('places shapes, takes placeholders from the layout and colours from the theme', () => {
    const deck = readPptx(pptx())!

    expect([deck.width, deck.height]).toEqual([9144000, 5143500])
    const slide = deck.slides[0]!
    const [title, ellipse] = slide.shapes

    expect(slide.background).toBe('#FAFAFA')
    expect(title).toMatchObject({ h: 400, kind: 'text', w: 3000, x: 100, y: 200 })
    expect(title!.paragraphs![0]!.views).toEqual([
      expect.objectContaining({ bold: true, color: '#4472C4', size: 44, text: 'Quarterly' }),
      { text: '\n' },
      expect.objectContaining({ text: 'review' })
    ])
    expect(ellipse).toMatchObject({ anchor: 'middle', fill: '#FF0000', round: 'ellipse' })
  })

  it('edits text around a line break and into an empty paragraph', () => {
    const pkg = pptx()
    const slide = readPptx(pkg)!.slides[0]!
    const [title, ellipse] = slide.shapes

    setSlideText(pkg, slide, title!.paragraphs![0]!, ['Yearly', '\n', 'review'])
    setSlideText(pkg, slide, ellipse!.paragraphs![0]!, ['Note'])
    const again = readPptx(reopen(pkg))!.slides[0]!

    expect(again.shapes[0]!.paragraphs![0]!.views.map(view => view.text)).toEqual([
      'Yearly',
      '\n',
      'review'
    ])
    expect(again.shapes[1]!.paragraphs![0]!.views).toEqual([
      expect.objectContaining({ size: 12, text: 'Note' })
    ])
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
