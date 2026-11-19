import { useEffect } from 'react';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PUBLIC_DEMO_SHARE_SLUG } from '@videoq/trpc/public-demo';
import { Button } from '@/components/ui/button';
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
      headerAction={(
        <Button asChild variant="solid" size="sm">
          <Link href="/signup" onClick={() => trackLandingEvent('signup_click', 'header')}>
            {t('tryDemo.signup')}<ArrowRight size={16} aria-hidden="true" />
          </Link>
        </Button>
      )}
      intro={<TrialIntroduction />}
      suggestedQuestions={QUESTION_KEYS.map(key => t(`tryDemo.questions.${key}`))}
      onCitationPlay={() => trackLandingEvent('demo_source')}
    />
  );
}

/** Shared with the keyboard review so it exercises the actual trial disclosure. */
export function TrialIntroduction() {
  const { t } = useTranslation();
  return <details className="text-std-16N-170 text-solid-gray-800">
    <summary className="app-focus min-h-11 cursor-pointer rounded-4 py-2 text-std-16N-170 text-key-900 underline underline-offset-4">{t('tryDemo.introSummary')}</summary>
    <p className="pb-2">{t('tryDemo.intro')}</p>
  </details>;
}
