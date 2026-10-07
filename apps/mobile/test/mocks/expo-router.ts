export const pushed: unknown[] = []

export const router = {
  back: () => undefined,
  dismiss: () => undefined,
  dismissTo: (href: unknown) => void pushed.push(href),
  push: (href: unknown) => void pushed.push(href),
  replace: (href: unknown) => void pushed.push(href)
}
