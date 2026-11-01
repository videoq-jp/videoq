import { useTranslation } from 'react-i18next';
import { Link } from '@/lib/i18n';
import { AppPageHeader } from '@/components/layout/AppPageHeader';
import { Heading, HeadingTitle } from '@/components/ui/heading';
import { UtilityLink } from '@/components/ui/utility-link';

export type LegalPageId = 'terms' | 'privacy' | 'refund' | 'scta';

const ARTICLE_SECTIONS: Record<Exclude<LegalPageId, 'scta'>, readonly string[]> = {
  terms: [
    'scope',
    'account',
    'plans',
    'payment',
    'cancel',
    'acceptableUse',
    'data',
    'liability',
    'changes',
    'contact',
  ],
  privacy: [
    'controller',
    'collect',
    'stripe',
    'purpose',
    'share',
    'retention',
    'rights',
    'cookies',
    'contact',
  ],
  refund: ['summary', 'digital', 'cancel', 'upgrade', 'howto', 'contact'],
};

const SCTA_FIELDS = [
  'seller',
  'operator',
  'address',
  'phone',
  'email',
  'url',
  'price',
  'fees',
  'payment',
  'delivery',
  'cancel',
] as const;

const RELATED_LINKS: { href: `/${string}`; titleKey: string }[] = [
  { href: '/terms', titleKey: 'legal.terms.title' },
  { href: '/privacy', titleKey: 'legal.privacy.title' },
  { href: '/refund', titleKey: 'legal.refund.title' },
  { href: '/legal', titleKey: 'legal.scta.title' },
];

export default function LegalPage({ page }: { page: LegalPageId }) {
  const { t } = useTranslation();

  return (
    <div className={page === 'scta' ? 'w-full' : 'mx-auto w-full max-w-3xl [overflow-wrap:anywhere]'}>
      <AppPageHeader
        title={t(`legal.${page}.title`)}
        description={t(`legal.${page}.updated`)}
      />

      {page === 'scta' ? (
        <dl className="divide-y divide-solid-gray-200 border-y border-solid-gray-420">
          {SCTA_FIELDS.map((field) => (
            <div
              key={field}
              className="grid gap-2 py-4 md:grid-cols-[14rem_1fr] md:gap-6"
            >
              <dt className="text-std-16B-170 text-solid-gray-800">
                {t(`legal.scta.fields.${field}.label`)}
              </dt>
              <dd className="text-std-16N-170 text-solid-gray-700">
                {t(`legal.scta.fields.${field}.value`)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="flex flex-col gap-8">
          {ARTICLE_SECTIONS[page].map((section) => (
            <section key={section}>
              <Heading size="18" className="mb-3">
                <HeadingTitle level="h2">
                  {t(`legal.${page}.sections.${section}.title`)}
                </HeadingTitle>
              </Heading>
              <p className="whitespace-pre-line text-std-16N-170 text-solid-gray-700">
                {t(`legal.${page}.sections.${section}.body`)}
              </p>
            </section>
          ))}
        </div>
      )}

      <nav className="mt-12 flex flex-wrap gap-x-6 gap-y-2 border-t border-solid-gray-420 pt-6">
        {RELATED_LINKS.filter((link) => link.titleKey !== `legal.${page}.title`).map(
          (link) => (
            <UtilityLink asChild key={link.href}>
              <Link href={link.href}>{t(link.titleKey)}</Link>
            </UtilityLink>
          ),
        )}
      </nav>
    </div>
  );
}
