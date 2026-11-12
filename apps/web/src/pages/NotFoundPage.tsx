import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocale } from '@/lib/i18n';
import { NOT_FOUND_COPY } from '@/lib/pageCopy';

export default function NotFoundPage() {
  const { t } = useTranslation();
  const locale = useLocale();

  // Also covers client navigation, where the Worker's 404 response never ran.
  useEffect(() => {
    document.title = NOT_FOUND_COPY[locale].title;
    document.querySelector('meta[name="robots"]')?.setAttribute('content', 'noindex, nofollow');
  }, [locale]);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-6 py-16 text-solid-gray-800">
      <p className="mb-2 text-std-17B-170 text-solid-gray-600">404</p>
      <h1 className="site-page-title mb-6 text-std-28B-150 md:text-std-45B-140">{t('notFound.title')}</h1>
      <p className="mb-8 text-std-17N-170 text-solid-gray-700">{t('notFound.body')}</p>
      <Link href="/" className="site-inline-link text-std-17N-170">{t('notFound.home')}</Link>
    </main>
  );
}
