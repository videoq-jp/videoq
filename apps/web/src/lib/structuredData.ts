import { providerDemoMedia } from './providerDemo';
import { absoluteUrl, SITE_ORIGIN, type SiteLocale } from './seo';

const ORGANIZATION_ID = `${SITE_ORIGIN}/#organization`;
const DEMO_UPLOAD_DATE = '2026-10-31';

export function homeStructuredData(locale: SiteLocale, description: string, demoTitle: string) {
  const home = absoluteUrl('/', locale);
  const demo = providerDemoMedia(locale);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${SITE_ORIGIN}/#website`,
        url: home,
        name: 'VideoQ',
        description,
        inLanguage: locale,
        publisher: { '@id': ORGANIZATION_ID },
      },
      {
        '@type': 'Organization',
        '@id': ORGANIZATION_ID,
        name: 'VideoQ',
        url: `${SITE_ORIGIN}/`,
        logo: { '@type': 'ImageObject', url: `${SITE_ORIGIN}/logo.png`, width: 512, height: 512 },
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${SITE_ORIGIN}/#app`,
        name: 'VideoQ',
        url: home,
        applicationCategory: 'EducationalApplication',
        operatingSystem: 'Web',
        description,
        inLanguage: locale,
        offers: {
          '@type': 'AggregateOffer',
          lowPrice: '0',
          priceCurrency: 'JPY',
          offerCount: 3,
          url: absoluteUrl('/pricing', locale),
        },
        publisher: { '@id': ORGANIZATION_ID },
      },
      {
        '@type': 'VideoObject',
        name: demoTitle,
        description,
        inLanguage: locale,
        duration: 'PT30S',
        uploadDate: DEMO_UPLOAD_DATE,
        thumbnailUrl: `${SITE_ORIGIN}${demo.poster}`,
        contentUrl: `${SITE_ORIGIN}${demo.video}`,
      },
    ],
  };
}

export function breadcrumbStructuredData(items: { name: string; url: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(({ name, url }, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name,
      item: url,
    })),
  };
}

export function articleStructuredData(article: {
  title: string;
  description: string;
  url: string;
  locale: SiteLocale;
  published: string;
  updated: string;
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title,
    description: article.description,
    inLanguage: article.locale,
    mainEntityOfPage: article.url,
    datePublished: article.published,
    dateModified: article.updated,
    author: { '@type': 'Organization', name: 'VideoQ', url: `${SITE_ORIGIN}/` },
    publisher: { '@id': ORGANIZATION_ID },
  };
}
