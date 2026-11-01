import { features } from "@/lib/deployment";
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { apiClient, type IntegrationApiKey, type IntegrationApiKeyCreateResponse } from '@/lib/api';
import { Link, useLocale } from '@/lib/i18n';
import { AppPageHeader } from '@/components/layout/AppPageHeader';
import { InlineSpinner } from '@/components/common/InlineSpinner';
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
import { Plus } from 'lucide-react';
import { AccountSettingsSection } from '@/components/auth/AccountSettingsSection';
import { ConnectedAppsSection } from '@/components/auth/ConnectedAppsSection';
import { ErrorMessage } from '@/components/auth/ErrorMessage';
import { MessageAlert } from '@/components/common/MessageAlert';
import { trpc } from '@/lib/trpc';

const SETTINGS_SECTION_CLASS =
  'scroll-mt-24 border-t border-solid-gray-200 pt-6';
const SETTINGS_CALLOUT_CLASS =
  'rounded-8 bg-solid-gray-50 p-4 text-std-16N-170 text-solid-gray-700';

type AccessLevel = 'all' | 'read_only';
type ApiKeyCopyState = { keyId: string; status: 'pending' | 'success' | 'error' };

export default function SettingsPage() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const locale = useLocale();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const billingNotice = searchParams.get('billing');

  const [isCreateApiKeyDialogOpen, setIsCreateApiKeyDialogOpen] = useState(false);
  const [apiKeyName, setApiKeyName] = useState('');
  const [apiKeyAccessLevel, setApiKeyAccessLevel] = useState<AccessLevel>('all');
  const [generatedApiKey, setGeneratedApiKey] = useState<IntegrationApiKeyCreateResponse | null>(null);
  const [apiKeyDialogError, setApiKeyDialogError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);
  const [pendingRevokeKey, setPendingRevokeKey] = useState<Pick<IntegrationApiKey, 'id' | 'config_id' | 'name' | 'prefix'> | null>(null);
  const [apiKeyCopy, setApiKeyCopy] = useState<ApiKeyCopyState | null>(null);
  const copyStatus = apiKeyCopy?.keyId === generatedApiKey?.id ? apiKeyCopy?.status : undefined;
  const [searchApiKey, setSearchApiKey] = useState('');
  const [searchApiStatusMessage, setSearchApiStatusMessage] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);
  const [showSearchApiKey, setShowSearchApiKey] = useState(false);
  const [editingSearchApiKey, setEditingSearchApiKey] = useState(false);
  const [confirmDeleteSearchApiKey, setConfirmDeleteSearchApiKey] = useState(false);

  const accessLevelOptions: {
    value: AccessLevel;
    title: string;
    description: string;
  }[] = [
    {
      value: 'all',
      title: t('settings.integrationApiKeys.permissions.allTitle'),
      description: t('settings.integrationApiKeys.permissions.allDescription'),
    },
    {
      value: 'read_only',
      title: t('settings.integrationApiKeys.permissions.readOnlyTitle'),
      description: t('settings.integrationApiKeys.permissions.readOnlyDescription'),
    },
  ];

  useEffect(() => {
    if (apiKeyCopy?.status !== 'success') {
      return undefined;
    }
    const timeoutId = window.setTimeout(() => {
      setApiKeyCopy(current => current === apiKeyCopy ? null : current);
    }, 2000);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [apiKeyCopy]);

  const apiKeysQuery = useQuery(trpc.account.integrationApiKeys.queryOptions());

  const searchApiKeyStatusQuery = useQuery({ ...trpc.account.searchApiKeyStatus.queryOptions(), enabled: features.youtube });

  const createApiKeyMutation = useMutation({
    mutationFn: () => apiClient.createIntegrationApiKey({
      name: apiKeyName.trim(),
      access_level: apiKeyAccessLevel,
    }),
    onSuccess: async (data) => {
      setApiKeyName('');
      setApiKeyAccessLevel('all');
      setIsCreateApiKeyDialogOpen(false);
      setGeneratedApiKey(data);
      setApiKeyDialogError(null);
      setApiKeyCopy(null);
      setStatusMessage(null);
      const filter = trpc.account.integrationApiKeys.queryFilter();
      await queryClient.cancelQueries(filter);
      if (queryClient.getQueryData(trpc.account.integrationApiKeys.queryKey())) {
        queryClient.setQueryData(trpc.account.integrationApiKeys.queryKey(), keys => {
          if (!keys || keys.some(key => key.id === data.id)) return keys;
          // Cache only list metadata; the secret belongs to the one-time dialog.
          return [{
            id: data.id,
            config_id: data.config_id,
            name: data.name,
            access_level: data.access_level,
            prefix: data.prefix,
            last_used_at: data.last_used_at,
            created_at: data.created_at,
          }, ...keys];
        });
      } else {
        // A creation can finish before the initial list. Load all existing keys.
        await queryClient.invalidateQueries(filter);
      }
    },
    onError: (error) => {
      setApiKeyDialogError(
        error instanceof Error
          ? error.message
          : t('settings.integrationApiKeys.errorCreating'),
      );
    },
  });

  const revokeApiKeyMutation = useMutation({
    mutationFn: ({ id, config_id }: Pick<IntegrationApiKey, 'id' | 'config_id'>) =>
      apiClient.revokeIntegrationApiKey(id, config_id),
    onMutate: () => setStatusMessage(null),
    onSuccess: async (_, { id }) => {
      await queryClient.cancelQueries(trpc.account.integrationApiKeys.queryFilter());
      queryClient.setQueryData(trpc.account.integrationApiKeys.queryKey(), keys => keys?.filter(key => key.id !== id));
      setPendingRevokeKey(null);
      setStatusMessage({
        tone: 'success',
        text: t('settings.integrationApiKeys.successRevoked'),
      });
    },
    onError: (error) => {
      setStatusMessage({
        tone: 'error',
        text: error instanceof Error
          ? error.message
          : t('settings.integrationApiKeys.errorRevoking'),
      });
    },
  });

  const isApiKeyMutationPending = createApiKeyMutation.isPending || revokeApiKeyMutation.isPending;

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

  const createApiKeyDialog = useDialog({
    open: isCreateApiKeyDialogOpen,
    onOpenChange: (open) => {
      setIsCreateApiKeyDialogOpen(open);
      if (!open) {
        setApiKeyName('');
        setApiKeyAccessLevel('all');
        setApiKeyDialogError(null);
      }
    },
    onRequestClose: (event) => {
      if (createApiKeyMutation.isPending) event.preventDefault();
    },
  });

  const generatedApiKeyDialog = useDialog({
    open: generatedApiKey !== null,
    onOpenChange: (open) => {
      if (!open) {
        setGeneratedApiKey(null);
        setApiKeyCopy(null);
      }
    },
  });

  const revokeConfirmDialog = useDialog({
    open: pendingRevokeKey !== null,
    onOpenChange: (open) => {
      if (!open) setPendingRevokeKey(null);
    },
    onRequestClose: (event) => {
      if (revokeApiKeyMutation.isPending) event.preventDefault();
    },
  });

  const handleCopyApiKey = async () => {
    if (!generatedApiKey) return;
    const attempt: ApiKeyCopyState = { keyId: generatedApiKey.id, status: 'pending' };
    setApiKeyCopy(attempt);
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(generatedApiKey.api_key);
        setApiKeyCopy(current => current === attempt ? { ...attempt, status: 'success' } : current);
        return;
      }
    } catch {
      // Show the same recovery message when permission is denied or unavailable.
    }
    setApiKeyCopy(current => current === attempt ? { ...attempt, status: 'error' } : current);
  };

  const getAccessLevelBadge = (accessLevel: AccessLevel) => {
    return (
      <ChipLabel variant="filled-1" color={accessLevel === 'read_only' ? 'blue' : 'gray'} className="min-h-0 text-oln-14N-100">
        {getAccessLevelLabel(accessLevel)}
      </ChipLabel>
    );
  };

  const getAccessLevelLabel = (accessLevel: AccessLevel) => {
    if (accessLevel === 'read_only') {
      return t('settings.integrationApiKeys.permissions.readOnlyTitle');
    }
    return t('settings.integrationApiKeys.permissions.allTitle');
  };

  return (
    <div>
      <AppPageHeader
        title={t('settings.title')}
        description={t(features.billing ? 'settings.subtitle' : 'onprem.settingsSubtitle')}
      />

      <nav aria-label={t('settings.navigation')} className="mb-6 flex flex-wrap gap-x-6 gap-y-2 border-b border-solid-gray-200 pb-4">
        <DaLink href="#account">{t('settings.account.title')}</DaLink>
        {features.billing && <DaLink href="#billing">{t('settings.billing.title')}</DaLink>}
        {features.youtube && <DaLink href="#youtube">{t('settings.searchApiKey.title')}</DaLink>}
        <DaLink href="#integrations">{t(features.emailDelivery ? 'settings.integrations.title' : 'onprem.localIntegrations')}</DaLink>
      </nav>

      <div className="flex flex-col gap-6">
          <AccountSettingsSection />
          {features.billing && <>
          <section id="billing" aria-labelledby="billing-heading" className={SETTINGS_SECTION_CLASS}>
            <div className="mb-4">
              <Heading size="20" hasChip className="mb-2">
                <HeadingTitle id="billing-heading" level="h2">{t('settings.billing.title')}</HeadingTitle>
              </Heading>
              <p className="text-std-16N-170 text-solid-gray-600">
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
                <p className="text-std-16N-170 text-solid-gray-600">{t('settings.billing.currentPlan')}</p>
                <p className="text-std-24B-150">{t(`pricing.plans.${user?.plan_code ?? 'free'}.name`)}</p>
              </div>
              <div className="flex flex-wrap gap-3">
                <Button asChild variant="outline">
                  <Link href="/pricing">{t('settings.billing.viewPlans')}</Link>
                </Button>
                {user?.plan_code === 'basic' || user?.plan_code === 'pro' ? (
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
                <Heading size="20" hasChip>
                  <HeadingTitle id="youtube-heading" level="h2">{t('settings.searchApiKey.title')}</HeadingTitle>
                </Heading>
                {searchApiKeyStatusQuery.isSuccess && (
                  <ChipLabel variant="filled-1" color={searchApiKeyStatusQuery.data.has_api_key ? 'blue' : 'gray'} className="shrink-0 text-oln-14N-100">
                    {t(searchApiKeyStatusQuery.data.has_api_key ? 'settings.searchApiKey.configured' : 'settings.searchApiKey.notConfigured')}
                  </ChipLabel>
                )}
              </div>
              <p className="text-std-16N-170 text-solid-gray-600">
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
                    href="https://www.searchapi.io/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    SearchAPI
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
            <Heading size="20" hasChip className="mb-4">
              <HeadingTitle id="integrations-heading" level="h2">{t(features.emailDelivery ? 'settings.integrations.title' : 'onprem.localIntegrations')}</HeadingTitle>
            </Heading>
            <ConnectedAppsSection headingLevel="h3" />
            <section className="mt-6 border-t border-solid-gray-200 pt-6" aria-labelledby="api-keys-heading">
            <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <Heading size="18" className="mb-2">
                  <HeadingTitle id="api-keys-heading" level="h3">{t('settings.integrationApiKeys.title')}</HeadingTitle>
                </Heading>
                <p className="text-std-16N-170 text-solid-gray-600">
                  {t('settings.integrationApiKeys.description')}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full shrink-0 sm:w-auto"
                disabled={isApiKeyMutationPending}
                onClick={() => {
                  setStatusMessage(null);
                  setApiKeyDialogError(null);
                  setApiKeyName('');
                  setApiKeyAccessLevel('all');
                  setIsCreateApiKeyDialogOpen(true);
                }}
              >
                <Plus className="w-4 h-4 mr-2" />
                {t('settings.integrationApiKeys.create')}
              </Button>
            </div>

            {statusMessage && !pendingRevokeKey && (
              <div className="mb-5">
                <MessageAlert type={statusMessage.tone} message={statusMessage.text} />
              </div>
            )}

            {apiKeysQuery.isLoading && <LoadingSpinner />}
            {apiKeysQuery.isError && (
              <ErrorMessage message={t('settings.integrationApiKeys.errorLoading')} />
            )}
            {!apiKeysQuery.isLoading && !apiKeysQuery.isError && apiKeysQuery.data?.length === 0 && (
              <p className="rounded-8 bg-solid-gray-50 p-4 text-std-16N-170 text-solid-gray-600">
                {t('settings.integrationApiKeys.empty')}
              </p>
            )}

            {apiKeysQuery.data && apiKeysQuery.data.length > 0 && (
              <ul aria-label={t('settings.integrationApiKeys.title')} className="divide-y divide-solid-gray-200 rounded-8 border border-solid-gray-200">
                {apiKeysQuery.data.map((apiKey) => (
                  <li key={apiKey.id} className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-words text-std-16B-170 [overflow-wrap:anywhere]">{apiKey.name}</p>
                        <p className="mt-1 break-all font-mono text-dns-14N-130 text-solid-gray-600">{apiKey.prefix}...</p>
                      </div>
                      <Button
                        type="button"
                        variant="text"
                        size="sm"
                        disabled={isApiKeyMutationPending}
                        onClick={() => {
                          setStatusMessage(null);
                          setPendingRevokeKey({ id: apiKey.id, config_id: apiKey.config_id, name: apiKey.name, prefix: apiKey.prefix });
                        }}
                        className="shrink-0 text-error-1 hover:bg-red-50"
                        aria-label={`${t('settings.integrationApiKeys.revoke')}: ${apiKey.name}`}
                      >
                        {revokeApiKeyMutation.isPending && revokeApiKeyMutation.variables.id === apiKey.id && <InlineSpinner className="mr-1 h-4 w-4" />}
                        {t('settings.integrationApiKeys.revoke')}
                      </Button>
                    </div>
                    <dl className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-dns-14N-130 text-solid-gray-600">
                      <div className="flex items-center gap-2">
                        <dt>{t('settings.integrationApiKeys.columns.permissions')}</dt>
                        <dd>{getAccessLevelBadge(apiKey.access_level)}</dd>
                      </div>
                      <div className="flex items-center gap-2">
                        <dt>{t('settings.integrationApiKeys.columns.lastUsed')}</dt>
                        <dd>{apiKey.last_used_at ? new Date(apiKey.last_used_at).toLocaleDateString(locale) : t('settings.integrationApiKeys.neverUsed')}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            )}
            </section>
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

      {/* ── Create API Key Dialog ──────────────────────────────────────── */}
      {isCreateApiKeyDialogOpen && (
        <Dialog {...createApiKeyDialog.dialogProps} width="min(42rem, 92vw)">
          <DialogContent>
            <DialogHeader>
              <DialogHeading {...createApiKeyDialog.headingProps}>
                {t('settings.integrationApiKeys.createDialogTitle')}
              </DialogHeading>
            </DialogHeader>

            <DialogBody>
              <p className="mb-4 text-std-16N-170 text-solid-gray-700">
                {t('settings.integrationApiKeys.createDialogDescription')}
              </p>

              <div className="space-y-6">
                {apiKeyDialogError && <ErrorMessage message={apiKeyDialogError} />}

                <div className="flex flex-col gap-2">
                  <Label htmlFor="api-key-name">
                    {t('settings.integrationApiKeys.nameLabel')}
                  </Label>
                  <Input
                    id="api-key-name"
                    value={apiKeyName}
                    onChange={(event) => setApiKeyName(event.target.value)}
                  />
                  <SupportText>{t('settings.integrationApiKeys.nameHelp')}</SupportText>
                </div>

                <div className="space-y-3">
                  <div className="space-y-1">
                    <p className="text-std-17B-170 text-solid-gray-800">
                      {t('settings.integrationApiKeys.permissionsLabel')}
                    </p>
                    <SupportText>{t('settings.integrationApiKeys.permissionsHelp')}</SupportText>
                  </div>
                  <div className="space-y-3">
                    {accessLevelOptions.map((option) => {
                      const isSelected = apiKeyAccessLevel === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          className={`w-full rounded-8 border px-4 py-4 text-left transition-colors focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-[calc(2/16*1rem)] focus-visible:outline-black focus-visible:ring-[calc(2/16*1rem)] focus-visible:ring-yellow-300 ${
                            isSelected
                              ? 'border-key-900 bg-key-900 text-white'
                              : 'border-solid-gray-300 bg-white text-solid-gray-800 hover:border-solid-gray-420 hover:bg-solid-gray-50'
                          }`}
                          onClick={() => setApiKeyAccessLevel(option.value)}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="space-y-1">
                              <div className="text-std-16B-170">{option.title}</div>
                              <div className={`text-std-16N-170 ${isSelected ? 'text-white/80' : 'text-solid-gray-600'}`}>
                                {option.description}
                              </div>
                            </div>
                            <span className={`mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-bold ${
                              isSelected
                                ? 'border-white bg-white text-key-900'
                                : 'border-solid-gray-420 text-transparent'
                            }`}>
                              •
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </DialogBody>

            <DialogActions>
              <div className="flex justify-end gap-3">
                <Button variant="outline" disabled={createApiKeyMutation.isPending} onClick={() => setIsCreateApiKeyDialogOpen(false)}>
                  {t('settings.integrationApiKeys.cancel')}
                </Button>
                <Button
                  disabled={createApiKeyMutation.isPending}
                  onClick={() => {
                    const trimmedName = apiKeyName.trim();
                    if (!trimmedName) {
                      setApiKeyDialogError(t('settings.integrationApiKeys.errorEmpty'));
                      return;
                    }
                    setApiKeyDialogError(null);
                    createApiKeyMutation.mutate();
                  }}
                >
                  {createApiKeyMutation.isPending ? (
                    <span className="flex items-center gap-2">
                      <InlineSpinner className="w-4 h-4" />
                      {t('settings.integrationApiKeys.creating')}
                    </span>
                  ) : t('settings.integrationApiKeys.createDialogCta')}
                </Button>
              </div>
            </DialogActions>
          </DialogContent>
        </Dialog>
      )}

      {/* ── Generated API Key Dialog ───────────────────────────────────── */}
      {generatedApiKey && (
        <Dialog {...generatedApiKeyDialog.dialogProps} width="min(36rem, 92vw)">
          <DialogContent>
            <DialogHeader>
              <DialogHeading {...generatedApiKeyDialog.headingProps}>
                {t('settings.integrationApiKeys.generatedDialogTitle')}
              </DialogHeading>
            </DialogHeader>

            <DialogBody>
              <p className="mb-4 text-std-16N-170 text-solid-gray-700">
                {t('settings.integrationApiKeys.generatedDialogDescription')}
              </p>

              {copyStatus === 'error' && (
                <div className="mb-4">
                  <ErrorMessage message={t('settings.integrationApiKeys.errorCopying')} />
                </div>
              )}

              <div className="space-y-6">
                <div className="flex flex-col gap-2">
                  <p className="text-std-17B-170 text-solid-gray-800">
                    {t('settings.integrationApiKeys.secretKeyLabel')}
                  </p>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_112px] sm:items-center">
                    <div className="min-w-0 rounded-8 border border-solid-gray-300 bg-solid-gray-50 px-4 py-3 font-mono text-std-16N-170 text-solid-gray-800">
                      <span className="block truncate">{generatedApiKey.api_key}</span>
                    </div>
                    <Button
                      variant={copyStatus === 'success' ? 'solid' : 'outline'}
                      className="h-10 w-full"
                      disabled={copyStatus === 'pending'}
                      aria-busy={copyStatus === 'pending'}
                      onClick={() => { void handleCopyApiKey(); }}
                    >
                      {copyStatus === 'success' ? t('settings.integrationApiKeys.copyDone') : t('settings.integrationApiKeys.copy')}
                    </Button>
                  </div>
                  <SupportText>{t('settings.integrationApiKeys.generatedTitle')}</SupportText>
                </div>

                <div className="flex flex-col gap-2">
                  <p className="text-std-17B-170 text-solid-gray-800">
                    {t('settings.integrationApiKeys.permissionsLabel')}
                  </p>
                  <p className="text-std-16N-170 text-solid-gray-800">
                    {getAccessLevelLabel(generatedApiKey.access_level)}
                  </p>
                  <SupportText>
                    {generatedApiKey.access_level === 'read_only'
                      ? t('settings.integrationApiKeys.permissions.readOnlyDescription')
                      : t('settings.integrationApiKeys.permissions.allDescription')}
                  </SupportText>
                </div>
              </div>
            </DialogBody>

            <DialogActions>
              <div className="flex justify-end gap-3">
                <Button
                  variant="outline"
                  onClick={() => {
                    setGeneratedApiKey(null);
                    setApiKeyCopy(null);
                    setStatusMessage({ tone: 'success', text: t('settings.integrationApiKeys.successCreated') });
                  }}
                >
                  {t('settings.integrationApiKeys.generatedDoneCta')}
                </Button>
              </div>
            </DialogActions>
          </DialogContent>
        </Dialog>
      )}

      {/* ── Revoke Confirm Dialog ──────────────────────────────────────── */}
      {pendingRevokeKey && (
        <Dialog {...revokeConfirmDialog.dialogProps} width="min(32rem, 92vw)">
          <DialogContent>
            <DialogHeader>
              <DialogHeading {...revokeConfirmDialog.headingProps}>
                {t('settings.integrationApiKeys.revokeConfirmTitle')}
              </DialogHeading>
            </DialogHeader>

            <DialogBody>
              <p className="mb-4 text-std-16N-170 text-solid-gray-700">
                {t('settings.integrationApiKeys.revokeConfirmDescription')}
              </p>

              <div className="space-y-4">
                {statusMessage?.tone === 'error' && <MessageAlert type="error" message={statusMessage.text} />}
                <MessageAlert
                  type="warning"
                  message={t('settings.integrationApiKeys.revokeConfirmWarning')}
                />
                <div className="rounded-8 border border-solid-gray-200 bg-solid-gray-50 px-4 py-4">
                  <div className="text-std-16B-170 text-solid-gray-800">{pendingRevokeKey.name}</div>
                  <div className="mt-1 font-mono text-dns-14N-130 text-solid-gray-600">{pendingRevokeKey.prefix}...</div>
                </div>
              </div>
            </DialogBody>

            <DialogActions>
              <div className="flex justify-end gap-3">
                <Button variant="outline" disabled={revokeApiKeyMutation.isPending} onClick={() => setPendingRevokeKey(null)}>
                  {t('settings.integrationApiKeys.cancel')}
                </Button>
                <Button
                  variant="solid"
                  className="bg-error-1 hover:bg-red-1000 active:bg-red-1200"
                  disabled={revokeApiKeyMutation.isPending}
                  onClick={() => revokeApiKeyMutation.mutate(pendingRevokeKey)}
                >
                  {revokeApiKeyMutation.isPending ? (
                    <span className="flex items-center gap-2">
                      <InlineSpinner className="w-4 h-4" />
                      {t('settings.integrationApiKeys.revoking')}
                    </span>
                  ) : t('settings.integrationApiKeys.revokeConfirmCta')}
                </Button>
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
