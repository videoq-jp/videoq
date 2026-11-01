import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AppPageHeader } from '@/components/layout/AppPageHeader';
import { StructuredData } from '@/components/seo/StructuredData';
import { Button } from '@/components/ui/button';
import { Heading, HeadingTitle } from '@/components/ui/heading';
import { UtilityLink } from '@/components/ui/utility-link';
import { GUIDE_BODIES } from '@/content/guides';
import { GUIDE_CATALOG, guideBySlug, guidePath } from '@/lib/guideCatalog';
import { Link, useLocale } from '@/lib/i18n';
import { absoluteUrl } from '@/lib/seo';
import { articleStructuredData, breadcrumbStructuredData } from '@/lib/structuredData';
import NotFoundPage from '@/pages/NotFoundPage';

export default function GuidePage() {
  const { t } = useTranslation();
  const locale = useLocale();
  const guide = guideBySlug(useParams().slug);
  if (!guide) return <NotFoundPage />;

  const { title, description } = guide[locale];
  const body = GUIDE_BODIES[guide.slug][locale];
  const url = absoluteUrl(guidePath(guide.slug), locale);

  return (
    <article className="max-w-3xl">
      <StructuredData data={articleStructuredData({ title, description, url, locale, published: guide.published, updated: guide.updated })} />
      <StructuredData data={breadcrumbStructuredData([
        { name: t('guides.home'), url: absoluteUrl('/', locale) },
        { name: t('guides.title'), url: absoluteUrl('/guides', locale) },
        { name: title, url },
      ])} />
      <nav aria-label={t('guides.title')} className="mb-6 text-std-16N-170">
        <UtilityLink asChild><Link href="/guides">{t('guides.title')}</Link></UtilityLink>
      </nav>
      <AppPageHeader title={title} description={body.intro} className="!mb-4" />
      <p className="mb-8 text-std-16N-170 text-solid-gray-600">
        {t('guides.author')} · {t('guides.updated')} <time dateTime={guide.updated}>{guide.updated}</time>
      </p>
      <nav aria-label={t('guides.toc')} className="mb-10 border border-solid-gray-420 p-6">
        <p className="mb-2 text-std-16B-170">{t('guides.toc')}</p>
        <ul className="list-disc space-y-1 pl-6 text-std-16N-170">
          {body.sections.map((section, index) => (
            <li key={section.heading}><a href={`#section-${index + 1}`} className="text-blue-1000 underline underline-offset-[0.1875rem]">{section.heading}</a></li>
          ))}
        </ul>
      </nav>
      <div className="space-y-10">
        {body.sections.map((section, index) => (
          <section key={section.heading} id={`section-${index + 1}`} className="scroll-mt-24">
            <Heading size="24" className="mb-3"><HeadingTitle level="h2">{section.heading}</HeadingTitle></Heading>
            {section.paragraphs.map(paragraph => (
              <p key={paragraph} className="mb-4 text-std-16N-170 text-solid-gray-800">{paragraph}</p>
            ))}
            {section.steps && (
              <ol className="list-decimal space-y-2 pl-6 text-std-16N-170 text-solid-gray-800">
                {section.steps.map(step => <li key={step}>{step}</li>)}
              </ol>
            )}
          </section>
        ))}
      </div>
      <aside className="mt-12 border-2 border-blue-900 p-6">
        <Heading size="20" className="mb-2"><HeadingTitle level="h2">{t('guides.ctaTitle')}</HeadingTitle></Heading>
        <p className="mb-4 text-std-16N-170 text-solid-gray-700">{t('guides.ctaBody')}</p>
        <div className="flex flex-wrap items-center gap-4">
          <Button asChild><Link href="/try">{t('guides.tryDemo')}</Link></Button>
          <Button variant="outline" asChild><Link href="/signup">{t('guides.cta')}</Link></Button>
          <UtilityLink asChild><Link href="/pricing">{t('guides.pricing')}</Link></UtilityLink>
        </div>
      </aside>
      <nav aria-label={t('guides.related')} className="mt-12">
        <Heading size="20" className="mb-3"><HeadingTitle level="h2">{t('guides.related')}</HeadingTitle></Heading>
        <ul className="space-y-2 text-std-16N-170">
          {GUIDE_CATALOG.filter(other => other.slug !== guide.slug).map(other => (
            <li key={other.slug}><Link href={guidePath(other.slug)} className="text-blue-1000 underline underline-offset-[0.1875rem]">{other[locale].title}</Link></li>
          ))}
        </ul>
      </nav>
    </article>
  );
}
