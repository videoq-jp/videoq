import { DEFAULT_COPY, resolveFirstByteCopy } from '../pageCopy'
import {
  absoluteUrl,
  hreflangEntries,
  isKnownPath,
  isNoindexPath,
  isPublicPath,
  localizedPath,
  pageMetaKey,
  serializeJsonLd,
  withQueryAndHash,
} from '../seo'

describe('isNoindexPath', () => {
  it('keeps the marketing homepage indexable', () => {
    expect(isNoindexPath('/')).toBe(false)
  })

  it('marks app and auth screens as noindex', () => {
    expect(isNoindexPath('/videos')).toBe(true)
    expect(isNoindexPath('/videos/12')).toBe(true)
    expect(isNoindexPath('/settings')).toBe(true)
    expect(isNoindexPath('/admin')).toBe(true)
    expect(isNoindexPath('/login')).toBe(true)
    expect(isNoindexPath('/signup/check-email')).toBe(true)
    expect(isNoindexPath('/share/token')).toBe(true)
  })

  it('keeps public marketing and legal pages indexable', () => {
    expect(isNoindexPath('/pricing')).toBe(false)
    expect(isNoindexPath('/try')).toBe(false)
    expect(isNoindexPath('/terms')).toBe(false)
  })
})

describe('localizedPath and absoluteUrl', () => {
  it('leaves Japanese unprefixed', () => {
    expect(localizedPath('/pricing', 'ja')).toBe('/pricing')
    expect(absoluteUrl('/', 'ja')).toBe('https://videoq.jp/')
  })

  it('prefixes English URLs with /en', () => {
    expect(localizedPath('/', 'en')).toBe('/en/')
    expect(absoluteUrl('/pricing', 'en')).toBe('https://videoq.jp/en/pricing')
  })
})

describe('hreflangEntries', () => {
  it('emits ja, en, and Japanese x-default', () => {
    const entries = hreflangEntries('/pricing')
    expect(entries).toEqual([
      { lang: 'ja', href: 'https://videoq.jp/pricing' },
      { lang: 'en', href: 'https://videoq.jp/en/pricing' },
      { lang: 'x-default', href: 'https://videoq.jp/pricing' },
    ])
  })
})

describe('pageMetaKey', () => {
  it('maps known public paths', () => {
    expect(pageMetaKey('/')).toBe('site')
    expect(pageMetaKey('/pricing')).toBe('pricing')
    expect(pageMetaKey('/legal')).toBe('legal.scta')
    expect(pageMetaKey('/share/token')).toBe('share:token')
  })

  it('treats a trailing slash as the same page', () => {
    expect(pageMetaKey('/pricing/')).toBe('pricing')
  })
})

describe('resolveFirstByteCopy', () => {
  it('keeps the homepage copy on /', () => {
    expect(resolveFirstByteCopy('ja', '/')).toEqual(DEFAULT_COPY.ja)
  })

  it('keeps the same copy when the path has a trailing slash', () => {
    expect(resolveFirstByteCopy('ja', '/pricing/')).toEqual(resolveFirstByteCopy('ja', '/pricing'))
  })

  it.each(['/pricing', '/terms', '/privacy', '/refund', '/legal'])('gives %s its own page title', (path) => {
    expect(resolveFirstByteCopy('ja', path).title).not.toBe(DEFAULT_COPY.ja.title)
    expect(resolveFirstByteCopy('en', path).title).not.toBe(DEFAULT_COPY.en.title)
  })
})

describe('withQueryAndHash', () => {
  it('keeps search and hash when stripping a locale prefix', () => {
    expect(withQueryAndHash('/pricing', '?plan=pro', '#plans')).toBe('/pricing?plan=pro#plans')
  })
})

describe('page classification', () => {
  it('treats guides as public pages', () => {
    expect(isPublicPath('/guides')).toBe(true)
    expect(isPublicPath('/guides/online-course-questions')).toBe(true)
    expect(resolveFirstByteCopy('en', '/guides/online-course-questions').title).toContain('online course')
  })

  it('does not treat unknown guides or paths as real pages', () => {
    expect(isKnownPath('/guides/unknown')).toBe(false)
    expect(isKnownPath('/no-such-page')).toBe(false)
    expect(resolveFirstByteCopy('ja', '/guides/unknown')).toEqual(DEFAULT_COPY.ja)
  })

  it('keeps application routes known', () => {
    expect(isKnownPath('/videos/12')).toBe(true)
  })
})

describe('serializeJsonLd', () => {
  it('cannot close its script element', () => {
    expect(serializeJsonLd({ text: '</script><script>alert(1)</script>' })).not.toContain('<')
  })
})
