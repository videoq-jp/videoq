import { articleStructuredData, breadcrumbStructuredData } from '../structuredData'

describe('breadcrumbStructuredData', () => {
  it('numbers the trail from one, in order', () => {
    const data = breadcrumbStructuredData([
      { name: 'Home', url: 'https://videoq.jp/en/' },
      { name: 'Guides', url: 'https://videoq.jp/en/guides' },
    ])
    expect(data['@type']).toBe('BreadcrumbList')
    expect(data.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://videoq.jp/en/' },
      { '@type': 'ListItem', position: 2, name: 'Guides', item: 'https://videoq.jp/en/guides' },
    ])
  })
})

describe('articleStructuredData', () => {
  it('publishes the guide details and real dates', () => {
    const data = articleStructuredData({
      title: 'Title',
      description: 'Description',
      url: 'https://videoq.jp/en/guides/example',
      locale: 'en',
      published: '2026-10-31',
      updated: '2026-11-02',
    })
    expect(data).toMatchObject({
      '@type': 'Article',
      headline: 'Title',
      description: 'Description',
      inLanguage: 'en',
      mainEntityOfPage: 'https://videoq.jp/en/guides/example',
      datePublished: '2026-10-31',
      dateModified: '2026-11-02',
    })
  })
})
