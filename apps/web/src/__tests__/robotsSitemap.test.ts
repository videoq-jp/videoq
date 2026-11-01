// @vitest-environment node
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import { SITE_ORIGIN, absoluteUrl, buildSitemap } from '@/lib/seo'
import { GUIDE_CATALOG, guidePath } from '@/lib/guideCatalog'
import { homeStructuredData } from '@/lib/structuredData'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('robots.txt', () => {
  const content = readFileSync(resolve(__dirname, '../../public/robots.txt'), 'utf-8')

  it('declares a sitemap', () => {
    expect(content).toContain('Sitemap: https://videoq.jp/sitemap.xml')
  })

  it('disallows app and auth paths in both locales', () => {
    expect(content).toContain('Disallow: /videos')
    expect(content).toContain('Disallow: /en/videos')
    expect(content).toContain('Disallow: /login')
    expect(content).toContain('Disallow: /en/login')
    expect(content).toContain('Disallow: /settings')
    expect(content).toContain('Disallow: /admin')
  })

  it('disallows every share page', () => {
    expect(content).toContain('Disallow: /share/')
    expect(content).toContain('Disallow: /en/share/')
    expect(content).not.toContain('Allow: /share/')
    expect(content).not.toContain('Allow: /en/share/')
  })

  it('does not disallow the homepage', () => {
    expect(content).not.toMatch(/^Disallow: \/$/m)
  })
})

describe('sitemap.xml', () => {
  const content = buildSitemap()

  it('is an XML urlset', () => {
    expect(content).toContain('<?xml version="1.0"')
    expect(content).toContain('<urlset')
  })

  it('dates only guides, from their real edit date', () => {
    for (const guide of GUIDE_CATALOG) {
      expect(content).toContain(`<loc>${absoluteUrl(guidePath(guide.slug), 'ja')}</loc>\n    <lastmod>${guide.updated}</lastmod>`)
    }
    expect(content).not.toContain(`<loc>${absoluteUrl('/pricing', 'ja')}</loc>\n    <lastmod>`)
  })

  it('lists every public index path in Japanese and English', () => {
    for (const path of ['/', '/pricing', '/terms', '/privacy', '/refund', '/legal', '/guides', ...GUIDE_CATALOG.map(guide => guidePath(guide.slug))]) {
      expect(content).toContain(`<loc>${absoluteUrl(path, 'ja')}</loc>`)
      expect(content).toContain(`<loc>${absoluteUrl(path, 'en')}</loc>`)
    }
  })

  it('does not list app, auth, or share URLs', () => {
    expect(content).not.toContain(`${SITE_ORIGIN}/videos`)
    expect(content).not.toContain(`${SITE_ORIGIN}/login`)
    expect(content).not.toContain(`${SITE_ORIGIN}/settings`)
    expect(content).not.toContain(`${SITE_ORIGIN}/share/`)
  })

  it('does not keep the old /ja/ locale prefix', () => {
    expect(content).not.toContain(`${SITE_ORIGIN}/ja/`)
    expect(content).not.toContain(`${SITE_ORIGIN}/ja</`)
  })
})

describe('index.html crawler copy', () => {
  const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf-8')

  it('points hreflang at Japanese default and /en/', () => {
    expect(html).toContain('hreflang="ja" href="https://videoq.jp/"')
    expect(html).toContain('hreflang="en" href="https://videoq.jp/en/"')
    expect(html).toContain('hreflang="x-default" href="https://videoq.jp/"')
    expect(html).not.toContain('https://videoq.jp/ja/')
  })

  it('leaves page JSON-LD to the prerendered page bodies', () => {
    expect(html).not.toContain('application/ld+json')
  })
})

describe('home structured data', () => {
  const data = JSON.stringify(homeStructuredData('en', 'Description', 'Demo'))

  it('describes the product and its demo in the page language', () => {
    expect(data).toContain('EducationalApplication')
    expect(data).toContain('AggregateOffer')
    expect(data).toContain('https://videoq.jp/demo/provider-demo-en.mp4')
    expect(data).toContain('"inLanguage":"en"')
  })
})
