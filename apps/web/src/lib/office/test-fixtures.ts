// Small Office files for tests, built from their XML parts.
import { strToU8, zipSync } from 'fflate'

import { OfficePackage } from './package'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships'

export const pack = (files: Record<string, string>) =>
  new OfficePackage(
    zipSync(
      Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new Uint8Array(strToU8(v))]))
    )
  )

export function docx() {
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

export function xlsx() {
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

export function pptx() {
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
