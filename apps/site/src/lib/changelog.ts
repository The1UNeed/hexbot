// The changelog page renders docs/releases/<version>.md, the same files the
// release workflow hands to GitHub as release notes (docs/release.md).

// Sorts versions newest first. A plain X.Y.Z ranks above its own prereleases.
export function newestFirst(a: string, b: string): number {
  const [coreA, preA] = split(a)
  const [coreB, preB] = split(b)
  return compare(coreB, coreA) || (preA && preB ? compare(preB, preA) : preA ? 1 : preB ? -1 : 0)
}

function split(version: string): [string, string] {
  const dash = version.indexOf('-')
  return dash < 0 ? [version, ''] : [version.slice(0, dash), version.slice(dash + 1)]
}

function compare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true })
}

// Each note opens with its own h1; on the page that becomes an h2 under "Changelog".
// Notes share section names ("Packages"), so the generated heading ids go.
export function demoteHeadings(html: string): string {
  return html
    .replace(/<(\/?)h([1-5])/g, (_, slash, level) => `<${slash}h${Number(level) + 1}`)
    .replace(/<(h[2-6]) id="[^"]*"/g, '<$1')
}
