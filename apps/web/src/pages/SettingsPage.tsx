import { isPaidPlan } from "@videoq/domain/billing-catalog";
import { features } from "@/lib/deployment";
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { Link, useLocale } from '@/lib/i18n';
import { AppPageHeader } from '@/components/layout/AppPageHeader';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SupportText } from '@/components/ui/support-text';
import { Link as DaLink } from '@/components/ui/link';
import { ChipLabel } from '@/components/ui/chip-label';
import { Heading, HeadingTitle } from '@/components/ui/heading';
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogHeading,
  useDialog,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AccountSettingsSection } from '@/components/auth/AccountSettingsSection';
import { IntegrationApiKeysSection } from '@/components/auth/IntegrationApiKeysSection';
import { ConnectedAppsSection } from '@/components/auth/ConnectedAppsSection';
import { ErrorMessage } from '@/components/auth/ErrorMessage';
import { MessageAlert } from '@/components/common/MessageAlert';
import { trpc } from '@/lib/trpc';

const SETTINGS_SECTION_CLASS =
  'scroll-mt-28';
const SETTINGS_CALLOUT_CLASS =
  'rounded-8 bg-solid-gray-50 p-4 text-std-17N-170 text-solid-gray-700';

export default function SettingsPage() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const locale = useLocale();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const billingNotice = searchParams.get('billing');

  const [searchApiKey, setSearchApiKey] = useState('');
  const [searchApiStatusMessage, setSearchApiStatusMessage] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);
  const [showSearchApiKey, setShowSearchApiKey] = useState(false);
  const [editingSearchApiKey, setEditingSearchApiKey] = useState(false);
  const [confirmDeleteSearchApiKey, setConfirmDeleteSearchApiKey] = useState(false);

  const searchApiKeyStatusQuery = useQuery({ ...trpc.account.searchApiKeyStatus.queryOptions(), enabled: features.youtube });

  const applySearchApiKeyStatus = async (hasApiKey: boolean) => {
    await queryClient.cancelQueries(trpc.account.searchApiKeyStatus.queryFilter());
    queryClient.setQueryData(trpc.account.searchApiKeyStatus.queryKey(), { has_api_key: hasApiKey });
    setSearchApiKey('');
    setShowSearchApiKey(false);
    setEditingSearchApiKey(false);
    setSearchApiStatusMessage({
      tone: 'success',
      text: t(hasApiKey ? 'settings.searchApiKey.successSaved' : 'settings.searchApiKey.successDeleted'),
    });
  };

  const saveSearchApiKeyMutation = useMutation(trpc.account.saveSearchApiKey.mutationOptions({
    onSuccess: () => applySearchApiKeyStatus(true),
    onError: (error) => {
      setSearchApiStatusMessage({
        tone: 'error',
        text: error instanceof Error
          ? error.message
          : t('settings.searchApiKey.errorSaving'),
      });
    },
  }));

  const deleteSearchApiKeyMutation = useMutation(trpc.account.deleteSearchApiKey.mutationOptions({
    onSuccess: () => applySearchApiKeyStatus(false),
    onError: (error) => {
      setSearchApiStatusMessage({
        tone: 'error',
        text: error instanceof Error
          ? error.message
          : t('settings.searchApiKey.errorDeleting'),
      });
    },
    onSettled: () => setConfirmDeleteSearchApiKey(false),
  }));

  const deleteSearchApiKeyDialog = useDialog({
    open: confirmDeleteSearchApiKey,
    onOpenChange: setConfirmDeleteSearchApiKey,
    onRequestClose: (event) => { if (deleteSearchApiKeyMutation.isPending) event.preventDefault(); },
  });

  return (
    <div>
      <AppPageHeader
        title={t('settings.title')}
        description={t(features.billing ? 'settings.subtitle' : 'onprem.settingsSubtitle')}
      />

      <nav aria-label={t('settings.navigation')} className="mb-6 flex flex-wrap gap-x-6 gap-y-2 pb-4">
        <DaLink href="#account">{t('settings.account.title')}</DaLink>
        {features.billing && <DaLink href="#billing">{t('settings.billing.title')}</DaLink>}
        {features.youtube && <DaLink href="#youtube">{t('settings.searchApiKey.title')}</DaLink>}
        <DaLink href="#integrations">{t(features.emailDelivery ? 'settings.integrations.title' : 'onprem.localIntegrations')}</DaLink>
      </nav>

      <div className="flex flex-col gap-16 md:gap-24">
          <AccountSettingsSection />
          {features.billing && <>
          <section id="billing" aria-labelledby="billing-heading" className={SETTINGS_SECTION_CLASS}>
            <div className="mb-4">
              <Heading size="32" className="text-std-24B-150 md:text-std-32B-150 mb-2">
                <HeadingTitle id="billing-heading" level="h2">{t('settings.billing.title')}</HeadingTitle>
              </Heading>
              <p className="text-std-17N-170 text-solid-gray-600">
                {t('settings.billing.description')}
              </p>
            </div>
            {billingNotice === 'success' && (
              <div className="mb-5">
                <MessageAlert type="success" message={t('settings.billing.success')} />
              </div>
            )}
            {user?.subscription_status === 'past_due' && (
              <div className="mb-5">
                <MessageAlert type="error" message={t('settings.billing.pastDue')} />
              </div>
            )}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-std-17N-170 text-solid-gray-600">{t('settings.billing.currentPlan')}</p>
                <p className="text-std-24B-150">{t(`pricing.plans.${user?.plan_code ?? 'free'}.name`)}</p>
              </div>
              <div className="flex flex-wrap gap-3">
                <Button asChild variant="outline">
                  <Link href="/pricing">{t('settings.billing.viewPlans')}</Link>
                </Button>
                {isPaidPlan(user?.plan_code ?? 'free') ? (
                  <ManageBillingButton locale={locale} />
                ) : null}
              </div>
            </div>
          </section>

          </>}
          {features.youtube && <>
          <section id="youtube" aria-labelledby="youtube-heading" className={SETTINGS_SECTION_CLASS}>
            <div className="mb-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <Heading size="32" className="text-std-24B-150 md:text-std-32B-150">
                  <HeadingTitle id="youtube-heading" level="h2">{t('settings.searchApiKey.title')}</HeadingTitle>
                </Heading>
                {searchApiKeyStatusQuery.isSuccess && (
                  <ChipLabel variant="filled-1" color={searchApiKeyStatusQuery.data.has_api_key ? 'blue' : 'gray'} className="shrink-0 text-oln-14N-100">
                    {t(searchApiKeyStatusQuery.data.has_api_key ? 'settings.searchApiKey.configured' : 'settings.searchApiKey.notConfigured')}
                  </ChipLabel>
                )}
              </div>
              <p className="text-std-17N-170 text-solid-gray-600">
                {t('settings.searchApiKey.description')}
              </p>
            </div>

            {searchApiStatusMessage && (
              <div className="mb-5">
                <MessageAlert
                  type={searchApiStatusMessage.tone}
                  message={searchApiStatusMessage.text}
                />
              </div>
            )}

            {searchApiKeyStatusQuery.isPending && <LoadingSpinner />}
            {searchApiKeyStatusQuery.isError && (
              <div className="space-y-3">
                <ErrorMessage message={t('settings.searchApiKey.errorLoading')} />
                <Button variant="outline" disabled={searchApiKeyStatusQuery.isFetching} aria-busy={searchApiKeyStatusQuery.isFetching}
                  onClick={() => void searchApiKeyStatusQuery.refetch({ cancelRefetch: false })}>{t('settings.retry')}</Button>
              </div>
            )}
            {searchApiKeyStatusQuery.isSuccess && <div className="space-y-4">
              <div className={SETTINGS_CALLOUT_CLASS}>
                <div className="font-bold text-solid-gray-800 mb-1">
                  {t('settings.searchApiKey.usageTitle')}
                </div>
                <p>{t('settings.searchApiKey.usageDescription')}</p>
              </div>

              {searchApiKeyStatusQuery.data.has_api_key && !editingSearchApiKey ? (
                <div className="flex flex-wrap gap-3">
                  <Button variant="outline" onClick={() => setEditingSearchApiKey(true)}>{t('settings.searchApiKey.edit')}</Button>
                  <Button variant="text" className="text-error-1" onClick={() => setConfirmDeleteSearchApiKey(true)}>{t('settings.searchApiKey.delete')}</Button>
                </div>
              ) : <form className="space-y-4" onSubmit={(event) => {
                event.preventDefault();
                if (!searchApiKey.trim() || saveSearchApiKeyMutation.isPending) return;
                setSearchApiStatusMessage(null);
                saveSearchApiKeyMutation.mutate({ apiKey: searchApiKey.trim() });
              }}>
              <div className="flex flex-col gap-2">
                <Label htmlFor="search-api-key">
                  {t('settings.searchApiKey.apiKeyLabel')}
                </Label>
                <Input
                  id="search-api-key"
                  type={showSearchApiKey ? 'text' : 'password'}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={saveSearchApiKeyMutation.isPending}
                  aria-describedby="search-api-key-help"
                  value={searchApiKey}
                  onChange={(event) => setSearchApiKey(event.target.value)}
                />
                <Button
                  type="button"
                  variant="text"
                  size="sm"
                  className="self-start"
                  aria-pressed={showSearchApiKey}
                  onClick={() => setShowSearchApiKey(!showSearchApiKey)}
                >
                  {t(showSearchApiKey ? 'settings.searchApiKey.hide' : 'settings.searchApiKey.show')}
                </Button>
                <SupportText id="search-api-key-help">
                  {searchApiKeyStatusQuery.data?.has_api_key
                    ? t('settings.searchApiKey.hasApiKeyMessage')
                    : t('settings.searchApiKey.noApiKeyMessage')}
                </SupportText>
                <SupportText>
                  {t('settings.searchApiKey.getApiKeyMessage')}{' '}
                  <DaLink
                    href="https://transcriptapi.com/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    TranscriptAPI
                  </DaLink>
                </SupportText>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2">
                {searchApiKeyStatusQuery.data.has_api_key && <Button
                  type="button"
                  variant="outline"
                  disabled={saveSearchApiKeyMutation.isPending}
                  onClick={() => {
                    setEditingSearchApiKey(false);
                    setSearchApiKey('');
                    setShowSearchApiKey(false);
                    setSearchApiStatusMessage(null);
                  }}
                >{t('settings.cancel')}</Button>}
                <Button
                  type="submit"
                  disabled={!searchApiKey.trim() || saveSearchApiKeyMutation.isPending || deleteSearchApiKeyMutation.isPending}
                >
                  {saveSearchApiKeyMutation.isPending ? t('settings.searchApiKey.saving') : t('settings.searchApiKey.save')}
                </Button>
              </div>
              </form>}
            </div>}
          </section>
          </>}

          {/* ── Integration API Keys ─────────────────────────────────── */}
          <section id="integrations" aria-labelledby="integrations-heading" className={SETTINGS_SECTION_CLASS}>
            <Heading size="32" className="text-std-24B-150 md:text-std-32B-150 mb-4">
              <HeadingTitle id="integrations-heading" level="h2">{t(features.emailDelivery ? 'settings.integrations.title' : 'onprem.localIntegrations')}</HeadingTitle>
            </Heading>
            <ConnectedAppsSection headingLevel="h3" />
            <IntegrationApiKeysSection />
          </section>
      </div>

      {confirmDeleteSearchApiKey && (
        <Dialog {...deleteSearchApiKeyDialog.dialogProps} width="min(32rem, 92vw)">
          <DialogContent>
            <DialogHeader><DialogHeading {...deleteSearchApiKeyDialog.headingProps}>{t('settings.searchApiKey.deleteConfirmTitle')}</DialogHeading></DialogHeader>
            <DialogBody><p>{t('settings.searchApiKey.deleteConfirmDescription')}</p></DialogBody>
            <DialogActions>
              <div className="flex flex-wrap justify-end gap-3">
                <Button variant="outline" disabled={deleteSearchApiKeyMutation.isPending} onClick={() => setConfirmDeleteSearchApiKey(false)}>{t('settings.cancel')}</Button>
                <Button className="bg-error-1 hover:bg-red-1000 active:bg-red-1200" disabled={deleteSearchApiKeyMutation.isPending} onClick={() => {
                  setSearchApiStatusMessage(null);
                  deleteSearchApiKeyMutation.mutate();
                }}>{t(deleteSearchApiKeyMutation.isPending ? 'settings.searchApiKey.deleting' : 'settings.searchApiKey.delete')}</Button>
              </div>
            </DialogActions>
          </DialogContent>
        </Dialog>
      )}


    </div>
  );
}

function ManageBillingButton({ locale }: { locale: 'en' | 'ja' }) {
  const { t } = useTranslation();
  const portal = useMutation(trpc.billing.portal.mutationOptions({
    onSuccess: (res) => {
      window.location.assign(res.url);
    },
  }));
  return (
    <Button type="button" variant="outline" disabled={portal.isPending} onClick={() => portal.mutate({ locale })}>
      {t('settings.billing.manage')}
    </Button>
  );
}
