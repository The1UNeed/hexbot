/**
 * An error as people read it. Providers answer with a status and a JSON body,
 * `400 {"error":{"message":"The requested model is not supported.",...}}`;
 * only the message inside is worth showing. Anything else stays as it is.
 */
export function plainError(text: string): string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')

  if (start < 0 || end < start) {
    return text
  }

  try {
    const body = JSON.parse(text.slice(start, end + 1)) as {
      error?: string | { message?: unknown }
      message?: unknown
    }

    const message =
      typeof body.error === 'string'
        ? body.error
        : typeof body.error?.message === 'string'
          ? body.error.message
          : body.message

    return typeof message === 'string' && message.trim() ? message.trim() : text
  } catch {
    return text
  }
}
