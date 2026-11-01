import { isOnprem } from "@/lib/deployment";
import { createElement } from 'react';
import { useNavigate, useLocation, useParams, Link as RouterLink, type LinkProps as RouterLinkProps } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect } from 'react';
import { locales, defaultLocale, type Locale } from '@/i18n/config';
import { NOT_FOUND_COPY, resolveFirstByteCopy } from '@/lib/pageCopy';
import {
  absoluteUrl,
  hreflangEntries,
  isKnownPath,
  isNoindexPath,
  pageMetaKey,
} from '@/lib/seo';

const LOCALE_STORAGE_KEY = 'videoq.locale';

function getLocaleFromPathname(pathname: string): Locale {
  const segments = pathname.split('/').filter(Boolean);
  const firstSegment = segments[0];
  if (firstSegment && locales.includes(firstSegment as Locale)) {
    return firstSegment as Locale;
  }
  return defaultLocale;
}

export function getSavedLocale(): Locale | null {
  if (typeof window === 'undefined') return null;
  try {
    const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (saved && locales.includes(saved as Locale)) {
      return saved as Locale;
    }
  } catch {
    // ignore
  }
  return null;
}

export function setPreferredLocale(locale: Locale): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // ignore
  }
}

export function removeLocalePrefix(pathname: string): string {
  const locale = getLocaleFromPathname(pathname);
  if (locale === defaultLocale) return pathname;
  const withoutLocale = pathname.replace(new RegExp(`^/${locale}(/|$)`), '/');
  return withoutLocale || '/';
}

export function addLocalePrefix(pathname: string, locale: Locale): string {
  if (locale === defaultLocale) return pathname;
  const cleanPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `/${locale}${cleanPath}`;
}

export function useI18nNavigate() {
  const navigate = useNavigate();
  const { i18n } = useTranslation();
  return useCallback((to: string | number, options?: { replace?: boolean }) => {
    if (typeof to === 'number') {
      navigate(to);
      return;
    }
    const locale = i18n.language as Locale;
    const localizedPath = addLocalePrefix(to, locale);
    navigate(localizedPath, options);
  }, [navigate, i18n.language]);
}

export function useI18nLocation() {
  const location = useLocation();
  const pathname = removeLocalePrefix(location.pathname);
  return { ...location, pathname };
}

export function useLocale(): Locale {
  const location = useLocation();
  return getLocaleFromPathname(location.pathname);
}

type AppLinkProps = Omit<RouterLinkProps, 'to'> & {
  /**
   * React Router's `to`.
   */
  to?: RouterLinkProps['to'];
  /**
   * Next.js style alias. Many migrated components/pages use `href`.
   */
  href?: RouterLinkProps['to'];
};

export function Link({ to, href, ...props }: AppLinkProps) {
  const { i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const target = href ?? to ?? '/';
  const localized = typeof target === 'string' ? addLocalePrefix(target, locale) : target;
  return createElement(RouterLink, { to: localized, ...props });
}

const OG_LOCALE_MAP: Record<Locale, string> = {
  en: 'en_US',
  ja: 'ja_JP',
};

function setMeta(selector: string, attribute: string, value: string) {
  const el = document.querySelector(selector);
  if (el) el.setAttribute(attribute, value);
}

function upsertLink(rel: string, href: string, hreflang?: string) {
  const selector = hreflang
    ? `link[rel="${rel}"][hreflang="${hreflang}"]`
    : `link[rel="${rel}"]:not([hreflang])`;
  let el = document.querySelector(selector);
  if (!el) {
    el = document.createElement('link');
    el.setAttribute('rel', rel);
    if (hreflang) el.setAttribute('hreflang', hreflang);
    document.head.appendChild(el);
  }
  el.setAttribute('href', href);
}

function resolvePageCopy(
  pathname: string,
  t: ReturnType<ReturnType<typeof useTranslation>['i18n']['getFixedT']>,
): { title: string; description: string } {
  const key = pageMetaKey(pathname);
  if (key === 'pricing') {
    return { title: `${t('pricing.title')} | VideoQ`, description: t('pricing.subtitle') };
  }
  if (key === 'tryDemo') {
    return { title: t('tryDemo.title'), description: t('tryDemo.description') };
  }
  if (key === 'legal.terms') {
    return { title: `${t('legal.terms.title')} | VideoQ`, description: t('legal.terms.title') };
  }
  if (key === 'legal.privacy') {
    return { title: `${t('legal.privacy.title')} | VideoQ`, description: t('legal.privacy.title') };
  }
  if (key === 'legal.refund') {
    return { title: `${t('legal.refund.title')} | VideoQ`, description: t('legal.refund.title') };
  }
  if (key === 'legal.scta') {
    return { title: `${t('legal.scta.title')} | VideoQ`, description: t('legal.scta.title') };
  }
  if (key === 'auth.login') {
    return { title: `${t('auth.login.title')} | VideoQ`, description: t('site.description') };
  }
  if (key === 'auth.signup') {
    return { title: `${t('auth.signup.title')} | VideoQ`, description: t('site.description') };
  }
  return { title: t('site.title'), description: t('site.description') };
}

function applyDocumentMeta(
  locale: Locale,
  pathname: string,
  i18n: ReturnType<typeof useTranslation>['i18n'],
) {
  if (isOnprem) {
    document.documentElement.lang = locale;
    document.title = 'VideoQ';
    document.querySelector('meta[name="robots"]')?.setAttribute('content', 'noindex, nofollow');
    for (const node of document.querySelectorAll('link[rel="canonical"], link[rel="alternate"][hreflang], meta[property^="og:"], meta[name^="twitter:"], script[type="application/ld+json"]')) node.remove();
    return;
  }
  document.documentElement.lang = locale;
  const t = i18n.getFixedT(locale);
  const known = isKnownPath(pathname);
  const { title, description } = !known ? NOT_FOUND_COPY[locale]
    : pathname === '/guides' || pathname.startsWith('/guides/') ? resolveFirstByteCopy(locale, pathname)
      : resolvePageCopy(pathname, t);
  const ogLocale = OG_LOCALE_MAP[locale];
  const canonical = absoluteUrl(pathname, locale);
  const robots = !known || isNoindexPath(pathname) ? 'noindex, nofollow' : 'index, follow';

  document.title = title;
  setMeta('meta[name="description"]', 'content', description);
  setMeta('meta[name="robots"]', 'content', robots);
  setMeta('meta[property="og:title"]', 'content', title);
  setMeta('meta[property="og:description"]', 'content', description);
  setMeta('meta[property="og:locale"]', 'content', ogLocale);
  setMeta('meta[property="og:url"]', 'content', canonical);
  upsertLink('canonical', canonical);
  for (const entry of hreflangEntries(pathname)) {
    upsertLink('alternate', entry.href, entry.lang);
  }
}

export function useLocaleSync() {
  const params = useParams<{ locale?: string }>();
  const location = useLocation();
  const { i18n } = useTranslation();
  useEffect(() => {
    const pathname = removeLocalePrefix(location.pathname);
    const urlLocale = params.locale;
    if (urlLocale && locales.includes(urlLocale as Locale)) {
      const normalized = urlLocale as Locale;
      if (normalized !== i18n.language) {
        i18n.changeLanguage(normalized).catch((error: unknown) => { console.error('Failed to change language', error); });
      }
      setPreferredLocale(normalized);
      applyDocumentMeta(normalized, pathname, i18n);
      return;
    }

    // Unprefixed URL is the default locale. Do not follow browser language —
    // Googlebot is typically English and would otherwise rewrite `/` to en.
    if (defaultLocale !== i18n.language) {
      i18n.changeLanguage(defaultLocale).catch((error: unknown) => { console.error('Failed to change language', error); });
    }
    applyDocumentMeta(defaultLocale, pathname, i18n);
  }, [params.locale, location.pathname, i18n]);
}
