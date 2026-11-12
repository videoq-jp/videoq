import { Button } from '@/components/ui/button';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from '@/lib/i18n';
import { trpc } from '@/lib/trpc';
import { trackLandingEvent } from '@/lib/landingAnalytics';

export function LandingFreePlan() {
  const { t } = useTranslation();
  const catalog = useQuery(trpc.billing.plans.queryOptions(undefined, {
    staleTime: 5 * 60_000,
    retry: false,
  }));
  const plan = catalog.data?.find(item => item.code === 'free');

  return (
    <section className="lp-free-plan lp-section" aria-labelledby="landing-free-title">
      <div>
        <p className="lp-eyebrow">{t('landing.free.eyebrow')}</p>
        <h2 id="landing-free-title">{t('landing.free.title')}</h2>
        <p className="lp-free-intro">{t('landing.free.intro')}</p>
        <p className="lp-reassurance"><Check size={15} aria-hidden="true" />{t('landing.startNote')}</p>
        <Button asChild className="lp-button"><Link href="/signup" onClick={() => trackLandingEvent('signup_click', 'free')}>
          {t('landing.start')}<ArrowRight size={17} aria-hidden="true" />
        </Link></Button>
        <Link href="/pricing" className="lp-text-link">{t('landing.next.pricing.title')}<ArrowRight size={15} aria-hidden="true" /></Link>
      </div>
      <div className="lp-free-details">
        {plan ? (
          <dl className="lp-free-limits">
            <div><dt>{t('landing.free.processing')}</dt><dd>{t('landing.free.minutes', { minutes: plan.entitlements.processing_limit_minutes })}</dd></div>
            <div><dt>{t('landing.free.answers')}</dt><dd>{t('landing.free.answerCount', { count: plan.entitlements.ai_answers_limit })}</dd></div>
            <div><dt>{t('landing.free.storage')}</dt><dd>{t('landing.free.gb', { gb: plan.entitlements.storage_limit_gb })}</dd></div>
            <div><dt>{t('landing.free.monthlyUpload')}</dt><dd>{t('landing.free.gb', { gb: plan.entitlements.monthly_upload_limit_gb })}</dd></div>
          </dl>
        ) : (
          <p className="lp-free-unavailable" role="status">{t(catalog.isPending ? 'landing.free.loading' : 'landing.free.unavailable')}</p>
        )}
        <div className="lp-free-sample">
          <p>{t('landing.free.sampleNote')}</p>
        </div>
      </div>
    </section>
  );
}
