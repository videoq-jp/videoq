import { useEffect } from 'react';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PUBLIC_DEMO_SHARE_SLUG } from '@videoq/trpc/public-demo';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Link } from '@/lib/i18n';
import { startLandingVisit, trackLandingEvent } from '@/lib/landingAnalytics';
import { SharedCourseView } from '@/pages/SharePage';

const QUESTION_KEYS = ['derivative', 'dna', 'price'] as const;

/** No-signup demo: visitors ask the sample course as if they were a student. */
export default function TryPage() {
  const { t } = useTranslation();
  // Visitors may arrive here directly, so a visit must exist for the demo events.
  useEffect(() => { startLandingVisit(); }, []);

  return (
    <SharedCourseView
      shareToken={PUBLIC_DEMO_SHARE_SLUG}
      loadingContent={(
        <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-6 py-12">
          <Link href="/" className="text-std-20B-150">VideoQ</Link>
          <h1 className="text-std-24B-150">{t('tryDemo.title')}</h1>
          <p className="text-std-16N-170">{t('tryDemo.intro')}</p>
          <ul className="list-disc space-y-2 pl-6 text-std-16N-170">
            {QUESTION_KEYS.map(key => <li key={key}>{t(`tryDemo.questions.${key}`)}</li>)}
          </ul>
          <LoadingSpinner />
          <Link href="/signup" className="text-blue-1000 underline underline-offset-4">{t('tryDemo.signup')}</Link>
        </main>
      )}
      headerAction={(
        <Button asChild variant="solid" size="sm">
          <Link href="/signup" onClick={() => trackLandingEvent('signup_click', 'header')}>
            {t('tryDemo.signup')}<ArrowRight size={16} aria-hidden="true" />
          </Link>
        </Button>
      )}
      intro={<p className="shrink-0 text-std-16N-170 text-solid-gray-800">{t('tryDemo.intro')}</p>}
      suggestedQuestions={QUESTION_KEYS.map(key => t(`tryDemo.questions.${key}`))}
      onCitationPlay={() => trackLandingEvent('demo_source')}
    />
  );
}
