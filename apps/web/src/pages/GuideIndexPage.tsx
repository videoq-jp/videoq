import { useTranslation } from 'react-i18next';
import { AppPageHeader } from '@/components/layout/AppPageHeader';
import { StructuredData } from '@/components/seo/StructuredData';
import { Heading, HeadingTitle } from '@/components/ui/heading';
import { GUIDE_CATALOG, guidePath } from '@/lib/guideCatalog';
import { Link, useLocale } from '@/lib/i18n';
import { absoluteUrl } from '@/lib/seo';
import { breadcrumbStructuredData } from '@/lib/structuredData';

export default function GuideIndexPage() {
  const { t } = useTranslation();
  const locale = useLocale();

  return (
    <>
      <StructuredData data={breadcrumbStructuredData([
        { name: t('guides.home'), url: absoluteUrl('/', locale) },
        { name: t('guides.title'), url: absoluteUrl('/guides', locale) },
      ])} />
      <AppPageHeader title={t('guides.title')} description={t('guides.intro')} />
      <ul className="grid gap-6 md:grid-cols-2">
        {GUIDE_CATALOG.map(guide => (
          <li key={guide.slug} className="flex flex-col border border-solid-gray-420 p-6">
            <Heading size="18" className="mb-2">
              <HeadingTitle level="h2">
                <Link href={guidePath(guide.slug)} className="text-blue-1000 underline underline-offset-[0.1875rem]">{guide[locale].title}</Link>
              </HeadingTitle>
            </Heading>
            <p className="text-std-16N-170 text-solid-gray-700">{guide[locale].description}</p>
          </li>
        ))}
      </ul>
    </>
  );
}
