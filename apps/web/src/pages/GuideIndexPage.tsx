import { useTranslation } from 'react-i18next';
import { AppPageHeader } from '@/components/layout/AppPageHeader';
import { StructuredData } from '@/components/seo/StructuredData';
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
      <ul className="grid gap-8 md:grid-cols-2">
        {GUIDE_CATALOG.map(guide => (
          <li key={guide.slug}>
            <Link href={guidePath(guide.slug)} className="site-card">
              <div className="site-card-body">
                <h2 className="site-card-title">{guide[locale].title}</h2>
                <p className="site-card-description">{guide[locale].description}</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
