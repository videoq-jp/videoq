import { GUIDE_CATALOG, guidePath } from './guideCatalog';

export const SITE_ORIGIN = 'https://videoq.jp';

const STATIC_PUBLIC_PATHS = ['/', '/pricing', '/terms', '/privacy', '/refund', '/legal', '/guides', '/try'] as const;

const NOINDEX_PREFIXES = [
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/change-email',
  '/consent',
  '/videos',
  '/settings',
  '/admin',
  '/share',
  '/course-invitations',
] as const;

export type SiteLocale = 'en' | 'ja';

export function normalizePathname(pathname: string): string {
  const withSlash = pathname.startsWith('/') ? pathname : `/${pathname}`;
  if (withSlash === '/') return '/';
  return withSlash.replace(/\/+$/, '');
}

function sharePathSlug(pathname: string): string | null {
  const match = normalizePathname(pathname).match(/^\/share\/([^/]+)$/);
  return match?.[1] ?? null;
}

export function isNoindexPath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return NOINDEX_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

/** Every page that is indexable, prerendered and listed in the sitemap. */
export function publicPaths(): string[] {
  return [...STATIC_PUBLIC_PATHS, ...GUIDE_CATALOG.map(guide => guidePath(guide.slug))];
}

export function isPublicPath(pathname: string): boolean {
  return publicPaths().includes(normalizePathname(pathname));
}

/** False for URLs no route serves: these answer 404 instead of a login redirect. */
export function isKnownPath(pathname: string): boolean {
  return isPublicPath(pathname) || isNoindexPath(pathname);
}

export function localizedPath(pathname: string, locale: SiteLocale): string {
  const normalized = normalizePathname(pathname);
  if (locale === 'ja') return normalized;
  return normalized === '/' ? '/en/' : `/en${normalized}`;
}

export function absoluteUrl(pathname: string, locale: SiteLocale): string {
  const path = localizedPath(pathname, locale);
  if (path === '/') return `${SITE_ORIGIN}/`;
  return `${SITE_ORIGIN}${path}`;
}

export function withQueryAndHash(pathname: string, search = '', hash = ''): string {
  return `${pathname}${search}${hash}`;
}

export function hreflangEntries(pathname: string): { lang: string; href: string }[] {
  return [
    { lang: 'ja', href: absoluteUrl(pathname, 'ja') },
    { lang: 'en', href: absoluteUrl(pathname, 'en') },
    { lang: 'x-default', href: absoluteUrl(pathname, 'ja') },
  ];
}

/** Lists only real pages. `lastmod` appears only where the content has a known edit date. */
export function buildSitemap(): string {
  const entries = publicPaths().flatMap((path) => {
    const updated = GUIDE_CATALOG.find(guide => guidePath(guide.slug) === path)?.updated;
    const alternates = hreflangEntries(path)
      .map(({ lang, href }) => `    <xhtml:link rel="alternate" hreflang="${lang}" href="${href}" />`)
      .join('\n');
    return (['ja', 'en'] as const).map(locale => [
      '  <url>',
      `    <loc>${absoluteUrl(path, locale)}</loc>`,
      ...(updated ? [`    <lastmod>${updated}</lastmod>`] : []),
      alternates,
      '  </url>',
    ].join('\n'));
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.join('\n')}
</urlset>
`;
}

/** Safe inside a script element: body text cannot close the tag. */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function pageMetaKey(pathname: string): string {
  pathname = normalizePathname(pathname);
  if (pathname === '/') return 'site';
  if (pathname === '/pricing') return 'pricing';
  if (pathname === '/try') return 'tryDemo';
  if (pathname === '/terms') return 'legal.terms';
  if (pathname === '/privacy') return 'legal.privacy';
  if (pathname === '/refund') return 'legal.refund';
  if (pathname === '/legal') return 'legal.scta';
  if (pathname === '/login') return 'auth.login';
  if (pathname === '/signup') return 'auth.signup';
  const shareSlug = sharePathSlug(pathname);
  if (shareSlug) return `share:${shareSlug}`;
  return 'site';
}
