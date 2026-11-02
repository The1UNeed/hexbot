import { describe, expect, it } from 'vitest'

import { plainError } from './plain-error'

describe('plainError', () => {
  it('keeps only the message from a provider status and JSON body', () => {
    expect(
      plainError(
        '400 {"error":{"message":"The requested model is not supported.","code":"model_not_supported","param":"model","type":"invalid_request_error"}}'
      )
    ).toBe('The requested model is not supported.')
    expect(plainError('429 {"error":"Rate limit reached"}')).toBe('Rate limit reached')
    expect(plainError('{"message":"Overloaded"}')).toBe('Overloaded')
  })

  it('leaves plain text and bodies without a message alone', () => {
    expect(plainError('Notion refused the request.')).toBe('Notion refused the request.')
    expect(plainError('500 {"code":"internal"}')).toBe('500 {"code":"internal"}')
    expect(plainError('Expected { here')).toBe('Expected { here')
  })
})
