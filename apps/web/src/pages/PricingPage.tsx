import { useQuery, useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { useAuthSession } from '@/lib/authSession';
import { Link, useLocale } from '@/lib/i18n';
import { AppPageHeader } from '@/components/layout/AppPageHeader';
import { Heading, HeadingTitle } from '@/components/ui/heading';
import { Button } from '@/components/ui/button';
import { MessageAlert } from '@/components/common/MessageAlert';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cn } from '@/lib/digital-agency/cn';

type Interval = 'month' | 'year';

function formatPrice(amount: number, currency: 'jpy' | 'usd', locale: string): string {
  return new Intl.NumberFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    currencyDisplay: currency === 'usd' ? 'code' : 'symbol',
  }).format(currency === 'usd' ? amount / 100 : amount);
}

export default function PricingPage() {
  const { t } = useTranslation();
  const locale = useLocale();
  const [searchParams] = useSearchParams();
  const [interval, setInterval] = useState<Interval>('month');
  const session = useAuthSession();
  const hasSession = Boolean(session.data?.user);
  const account = useQuery(trpc.account.me.queryOptions(undefined, {
    enabled: hasSession && !session.isPending,
    retry: false,
    staleTime: 60_000,
  }));
  const catalog = useQuery(trpc.billing.plans.queryOptions({ locale }));

  const canceled = searchParams.get('billing') === 'cancel';
  const currentPlan = hasSession ? account.data?.plan_code : undefined;
  const awaitingAccount = session.isPending || (hasSession && account.isPending);
  const loadError = catalog.error ?? (hasSession ? account.error : null);
  const cards = (catalog.data ?? []).filter(plan => plan.code === 'free' || plan.interval === interval);

  const checkout = useMutation(trpc.billing.checkout.mutationOptions({
    onSuccess: (res) => {
      window.location.assign(res.url);
    },
  }));

  const portal = useMutation(trpc.billing.portal.mutationOptions({
    onSuccess: (res) => {
      window.location.assign(res.url);
    },
  }));
  const actionError = checkout.error ?? portal.error;

  return (
    <>
      <AppPageHeader
        title={t('pricing.title')}
        description={t('pricing.subtitle')}
      />

      {canceled && (
        <div className="mb-6">
          <MessageAlert type="warning" message={t('pricing.canceled')} />
        </div>
      )}
      {loadError && (
        <div className="mb-6 space-y-2">
          <MessageAlert type="error" message={loadError.message} />
          <Button
            type="button"
            variant="outline"
            disabled={catalog.isFetching || (hasSession && account.isFetching)}
            onClick={() => {
              if (catalog.isError) void catalog.refetch();
              if (hasSession && account.isError) void account.refetch();
            }}
          >
            {t('pricing.retry')}
          </Button>
        </div>
      )}
      {actionError && (
        <div className="mb-6">
          <MessageAlert type="error" message={actionError.message} />
        </div>
      )}

      <div className="mb-8 flex gap-2">
        <Button
          type="button"
          variant={interval === 'month' ? 'solid-fill' : 'outline'}
          onClick={() => setInterval('month')}
        >
          {t('pricing.monthly')}
        </Button>
        <Button
          type="button"
          variant={interval === 'year' ? 'solid-fill' : 'outline'}
          onClick={() => setInterval('year')}
        >
          {t('pricing.yearly')}
        </Button>
      </div>

      {catalog.isLoading ? (
        <div className="flex justify-center py-24">
          <LoadingSpinner />
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-3">
          {cards.map((plan) => {
            const isCurrent = plan.code === currentPlan;
            return (
              <section
                key={`${plan.code}-${plan.interval ?? 'free'}`}
                className={cn(
                  'flex flex-col border border-solid-gray-420 p-6',
                  isCurrent && 'border-2 border-blue-900',
                )}
              >
                <Heading size="18" className="mb-2">
                  <HeadingTitle level="h2">{t(`pricing.plans.${plan.code}.name`)}</HeadingTitle>
                </Heading>
                <p className="mb-4 text-std-17N-170 text-solid-gray-700">
                  {t(`pricing.plans.${plan.code}.blurb`)}
                </p>
                <p className="mb-6 text-std-20B-150 text-solid-gray-800">
                  {plan.code === 'free'
                    ? t('pricing.freePrice')
                    : `${formatPrice(plan.unit_amount, plan.currency, locale)}${interval === 'year' ? t('pricing.perYear') : t('pricing.perMonth')}`}
                </p>
                <ul className="mb-6 flex-1 space-y-2 text-std-17N-170 text-solid-gray-700">
                  <li>
                    {t('pricing.limits.storage', { gb: plan.entitlements.storage_limit_gb })}
                  </li>
                  <li>
                    {t('pricing.limits.processing', {
                      minutes: plan.entitlements.processing_limit_minutes,
                    })}
                  </li>
                  <li>
                    {t('pricing.limits.answers', {
                      count: plan.entitlements.ai_answers_limit,
                    })}
                  </li>
                  <li>
                    {t('pricing.limits.monthlyUpload', {
                      gb: plan.entitlements.monthly_upload_limit_gb,
                    })}
                  </li>
                </ul>
                {!hasSession && !session.isPending ? (
                  <Button asChild variant={plan.code === 'free' ? 'outline' : 'solid-fill'}>
                    <Link href="/signup">{t(plan.code === 'free' ? 'pricing.startFree' : 'pricing.signUpToSubscribe')}</Link>
                  </Button>
                ) : awaitingAccount || !account.data ? (
                  <Button type="button" disabled>
                    {t(awaitingAccount ? 'pricing.loadingAccount' : 'pricing.accountUnavailable')}
                  </Button>
                ) : plan.code === 'free' && isCurrent ? (
                  <p className="text-std-17N-170 text-solid-gray-600">{t('pricing.currentPlan')}</p>
                ) : currentPlan !== 'free' ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={portal.isPending}
                    onClick={() => portal.mutate({ locale })}
                  >
                    {t(isCurrent ? 'pricing.manage' : 'pricing.changePlan')}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    disabled={!plan.lookup_key || checkout.isPending}
                    onClick={() => plan.lookup_key && checkout.mutate({
                      lookupKey: plan.lookup_key,
                      locale,
                    })}
                  >
                    {t('pricing.subscribe')}
                  </Button>
                )}
              </section>
            );
          })}
        </div>
      )}
      <p className="mt-6 text-std-17N-170 text-solid-gray-600">{t('pricing.ownerNote')}</p>
    </>
  );
}
