import { isPublicAuthPath } from '../authConfig'

describe('isPublicAuthPath', () => {
  it('treats the marketing homepage as public', () => {
    expect(isPublicAuthPath('/')).toBe(true)
  })

  it('does not treat every path as public just because it starts with /', () => {
    expect(isPublicAuthPath('/videos')).toBe(false)
    expect(isPublicAuthPath('/settings')).toBe(false)
  })

  it('keeps existing public prefixes', () => {
    expect(isPublicAuthPath('/login')).toBe(true)
    expect(isPublicAuthPath('/teaching/connect')).toBe(true)
    expect(isPublicAuthPath('/docs/openai')).toBe(false)
    expect(isPublicAuthPath('/pricing')).toBe(true)
  })
})
