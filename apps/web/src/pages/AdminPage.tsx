import { isOnprem } from "@/lib/deployment";
import { OnpremUserProvisioning, ResetUserAccessButton } from "@/components/auth/OnpremUserProvisioning";
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { adminInputSchemas } from '@videoq/trpc/admin';
import { useAuth } from '@/hooks/useAuth';
import { useI18nNavigate } from '@/lib/i18n';
import type { AdminUser } from '@/lib/api';
import { getApiError } from '@/lib/api-error';
import { appTrpcClient, trpc } from '@/lib/trpc';
import { refreshQuery } from '@/lib/cacheInvalidation';
import { AppPageHeader } from '@/components/layout/AppPageHeader';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import { MessageAlert } from '@/components/common/MessageAlert';
import { ErrorMessage } from '@/components/auth/ErrorMessage';
import { FormField } from '@/components/auth/FormField';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SupportText } from '@/components/ui/support-text';
import { Button } from '@/components/ui/button';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const SECTION_CLASS = 'pt-8';
const PAGE_SIZE = 20;

const quotaFormSchema = adminInputSchemas['admin.patchQuota']
  .omit({ id: true, quota_source: true }).required();
const usageFormSchema = adminInputSchemas['admin.patchUsage']
  .omit({ id: true, usage_period_start: true }).required();
const QUOTA_ERRORS = {
  monthly_upload_limit_gb: 'admin.users.errors.invalidMonthlyUploadGb',
  storage_limit_gb: 'admin.users.errors.invalidStorageGb',
  processing_limit_minutes: 'admin.users.errors.invalidProcessingMinutes',
  ai_answers_limit: 'admin.users.errors.invalidAiLimit',
} as const;
const FIELD_IDS = {
  monthly_upload_limit_gb: 'admin-monthly-upload',
  storage_limit_gb: 'admin-storage-gb',
  processing_limit_minutes: 'admin-processing-min',
  ai_answers_limit: 'admin-ai-limit',
  used_storage_bytes: 'admin-used-storage',
  used_processing_seconds: 'admin-used-processing',
  used_ai_answers: 'admin-used-ai',
} as const;
type FieldErrors = Partial<Record<keyof typeof FIELD_IDS, string>>;
type UserSettingsInput = {
  quota: ReturnType<typeof quotaFormSchema.parse>;
  usage: ReturnType<typeof usageFormSchema.parse>;
};

function numberInput(value: string): number | null {
  return value.trim() === '' ? null : Number(value);
}

function changedFields<K extends keyof AdminUser>(
  current: AdminUser,
  values: Pick<AdminUser, K>,
): Partial<Pick<AdminUser, K>> {
  const patch: Partial<Pick<AdminUser, K>> = {};
  for (const key of Object.keys(values) as K[]) {
    if (values[key] !== current[key]) patch[key] = values[key];
  }
  return patch;
}

export default function AdminPage() {
  const { user, isLoading: authLoading } = useAuth();
  const { t } = useTranslation();
  const navigate = useI18nNavigate();
  const queryClient = useQueryClient();
  const usersTableId = useId();
  const usersHeadingRef = useRef<HTMLHeadingElement>(null);
  const userActionTriggerRef = useRef<HTMLButtonElement>(null);
  const formErrorRef = useRef<HTMLDivElement>(null);

  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [userToDelete, setUserToDelete] = useState<AdminUser | null>(null);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(() => new Set());
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isReindexOpen, setIsReindexOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const [monthlyUploadGb, setMonthlyUploadGb] = useState('');
  const [storageLimitGb, setStorageLimitGb] = useState('');
  const [processingLimitMinutes, setProcessingLimitMinutes] = useState('');
  const [aiAnswersLimit, setAiAnswersLimit] = useState('');
  const [usedStorageBytes, setUsedStorageBytes] = useState('');
  const [usedProcessingSeconds, setUsedProcessingSeconds] = useState('');
  const [usedAiAnswers, setUsedAiAnswers] = useState('');
  const [isOverQuota, setIsOverQuota] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [isAdminFlag, setIsAdminFlag] = useState(false);

  const isAdmin = !!user?.is_admin;

  useEffect(() => {
    if (authLoading) return;
    if (!user) return;
    if (!isAdmin) navigate('/');
  }, [authLoading, user, isAdmin, navigate]);

  const restoreUserListFocus = () => {
    const trigger = userActionTriggerRef.current;
    if (trigger && (!trigger.isConnected || trigger.disabled)) {
      usersHeadingRef.current?.focus();
    }
  };

  const openEditUser = (row: AdminUser, trigger: HTMLButtonElement) => {
    userActionTriggerRef.current = trigger;
    setSelectedUser(row);
    setMonthlyUploadGb(row.monthly_upload_limit_gb === null ? '' : String(row.monthly_upload_limit_gb));
    setStorageLimitGb(row.storage_limit_gb == null ? '' : String(row.storage_limit_gb));
    setProcessingLimitMinutes(
      row.processing_limit_minutes == null ? '' : String(row.processing_limit_minutes),
    );
    setAiAnswersLimit(row.ai_answers_limit == null ? '' : String(row.ai_answers_limit));
    setUsedStorageBytes(String(row.used_storage_bytes));
    setUsedProcessingSeconds(String(row.used_processing_seconds));
    setUsedAiAnswers(String(row.used_ai_answers));
    setIsOverQuota(row.is_over_quota);
    setIsActive(row.is_active);
    setIsAdminFlag(row.is_admin);
    setFormError(null);
    setFieldErrors({});
    setIsEditOpen(true);
  };

  const usersQuery = useQuery(trpc.admin.listUsers.queryOptions({
    q: query || undefined,
    limit: PAGE_SIZE,
    offset,
  }, {
    enabled: isAdmin,
  }));

  const saveMutation = useMutation({
    onMutate: () => setFormError(null),
    mutationFn: async (input: UserSettingsInput) => {
      if (!selectedUser) throw new Error('No user selected');

      const quota = changedFields(selectedUser, input.quota);
      const usage = changedFields(selectedUser, input.usage);
      const flags = changedFields(selectedUser, {
        is_active: isActive,
        is_admin: isAdminFlag,
      });

      const id = selectedUser.id;
      const updates = [
        { patch: flags, save: () => appTrpcClient.admin.patchFlags.mutate({ id, ...flags }) },
        { patch: quota, save: () => appTrpcClient.admin.patchQuota.mutate({ id, ...quota }) },
        { patch: usage, save: () => appTrpcClient.admin.patchUsage.mutate({ id, ...usage }) },
      ].filter(({ patch }) => Object.keys(patch).length > 0);
      if (updates.length === 0) return;

      try {
        for (const { patch, save } of updates) {
          await save();
          // Remember acknowledged edits for retries without adopting unrelated
          // server changes (for example, usage accumulated while the form is open).
          setSelectedUser(current => current?.id === id ? { ...current, ...patch } : current);
        }
      } finally {
        await refreshQuery(queryClient, trpc.admin.listUsers.pathFilter());
      }
    },
    onSuccess: () => {
      setStatusMessage({ type: 'success', text: t('admin.users.saveSuccess') });
      setIsEditOpen(false);
      setSelectedUser(null);
    },
    onError: (error) => {
      const message =
        getApiError(error)?.message ?? t('admin.users.saveError');
      setFormError(message);
    },
  });

  const saveUser = () => {
    const quotaInput = quotaFormSchema.safeParse({
      monthly_upload_limit_gb: numberInput(monthlyUploadGb),
      storage_limit_gb: numberInput(storageLimitGb),
      processing_limit_minutes: numberInput(processingLimitMinutes),
      ai_answers_limit: numberInput(aiAnswersLimit),
    });
    const usageInput = usageFormSchema.safeParse({
      used_storage_bytes: numberInput(usedStorageBytes),
      used_processing_seconds: numberInput(usedProcessingSeconds),
      used_ai_answers: numberInput(usedAiAnswers),
      is_over_quota: isOverQuota,
    });
    const errors: FieldErrors = {};
    if (!quotaInput.success) {
      for (const issue of quotaInput.error.issues) {
        const field = issue.path[0] as keyof typeof QUOTA_ERRORS;
        errors[field] = t(QUOTA_ERRORS[field]);
      }
    }
    if (!usageInput.success) {
      for (const issue of usageInput.error.issues) {
        const field = issue.path[0] as keyof typeof FIELD_IDS;
        errors[field] = t('admin.users.errors.invalidUsage');
      }
    }
    setFieldErrors(errors);
    setFormError(null);
    if (!quotaInput.success || !usageInput.success) return;
    saveMutation.mutate({ quota: quotaInput.data, usage: usageInput.data });
  };

  const reindexMutation = useMutation(trpc.admin.reindexAll.mutationOptions({
    onSuccess: (result) => {
      setStatusMessage({
        type: 'success',
        text: t('admin.reindex.success', { jobId: result.job_id }),
      });
      setIsReindexOpen(false);
    },
    onError: (error) => {
      const message =
        getApiError(error)?.message ?? t('admin.reindex.error');
      setStatusMessage({ type: 'error', text: message });
      setIsReindexOpen(false);
    },
  }));

  const deleteMutation = useMutation({
    mutationFn: (target: AdminUser) => appTrpcClient.admin.deleteUser.mutate({ id: target.id }),
    onSuccess: async (result, target) => {
      setStatusMessage({
        type: 'success',
        text: t('admin.users.deleteSuccess', {
          username: target.username,
          jobId: result.job_id,
        }),
      });
      setIsDeleteOpen(false);
      setUserToDelete(null);
      setPendingDeleteIds((prev) => new Set(prev).add(target.id));
      await refreshQuery(queryClient, trpc.admin.listUsers.pathFilter());
    },
    onError: (error) => {
      const message =
        getApiError(error)?.message ?? t('admin.users.deleteError');
      setStatusMessage({ type: 'error', text: message });
      setIsDeleteOpen(false);
    },
  });

  const editDialog = useDialog({
    open: isEditOpen,
    onOpenChange: (open) => {
      setIsEditOpen(open);
      if (!open) {
        setSelectedUser(null);
        setFormError(null);
      }
    },
    onRequestClose: (event) => {
      if (saveMutation.isPending) event.preventDefault();
    },
  });

  const { ref: editDialogRef } = editDialog.dialogProps;
  useEffect(() => {
    if (!isEditOpen) return;
    if (formError) {
      formErrorRef.current?.focus();
      return;
    }
    const firstInvalidField = Object.keys(fieldErrors)[0] as keyof typeof FIELD_IDS | undefined;
    if (firstInvalidField) {
      editDialogRef.current?.querySelector<HTMLInputElement>(`#${FIELD_IDS[firstInvalidField]}`)?.focus();
    }
  }, [fieldErrors, formError, isEditOpen, editDialogRef]);

  const deleteDialog = useDialog({
    open: isDeleteOpen,
    onOpenChange: (open) => {
      setIsDeleteOpen(open);
      if (!open) {
        setUserToDelete(null);
      }
    },
    onRequestClose: (event) => {
      if (deleteMutation.isPending) event.preventDefault();
    },
  });

  const reindexDialog = useDialog({
    open: isReindexOpen,
    onOpenChange: setIsReindexOpen,
    onRequestClose: (event) => {
      if (reindexMutation.isPending) event.preventDefault();
    },
  });

  const visibleUsers = usersQuery.data?.data ?? [];
  const total = usersQuery.data?.meta.total ?? 0;
  const lastOffset = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1) * PAGE_SIZE;
  const isPageOutOfRange = offset > lastOffset;
  // A cached empty page may have gained users since it was last visited.
  if (usersQuery.isSuccess && !usersQuery.isFetching && isPageOutOfRange) setOffset(lastOffset);
  const isUsersLoading = usersQuery.isLoading || (usersQuery.isFetching && isPageOutOfRange);
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;
  const pageLabel =
    total === 0
      ? t('admin.users.empty')
      : t('admin.users.pageRange', {
          from: offset + 1,
          to: Math.min(offset + PAGE_SIZE, total),
          total,
        });

  if (authLoading && !user) return <LoadingSpinner fullScreen />;
  if (!user || !isAdmin) return <LoadingSpinner fullScreen />;

  return (
    <>
      <AppPageHeader
        title={t('admin.title')}
        description={t('admin.description')}
      />

      {statusMessage && (
        <div className="mb-6 [overflow-wrap:anywhere]">
          <MessageAlert type={statusMessage.type} message={statusMessage.text} />
        </div>
      )}

      <section className={`${SECTION_CLASS} @container`}>
        <Heading size="32" className="text-std-24B-150 md:text-std-32B-150 mb-4">
          <HeadingTitle level="h2" ref={usersHeadingRef} tabIndex={-1}>{t('admin.users.title')}</HeadingTitle>
        </Heading>
        <SupportText className="mb-4">{t('admin.users.description')}</SupportText>

        {isOnprem && <OnpremUserProvisioning />}
        <form
          className="mb-6 max-w-2xl"
          onSubmit={(event) => {
            event.preventDefault();
            const nextQuery = searchInput.trim();
            if (nextQuery === query && offset === 0) {
              void usersQuery.refetch();
              return;
            }
            setOffset(0);
            setQuery(nextQuery);
          }}
        >
          <Label htmlFor="admin-user-search" className="mb-2 block">{t('admin.users.searchLabel')}</Label>
          <div className="flex flex-wrap items-center gap-3">
            <Input
              id="admin-user-search"
              blockSize="md"
              className="min-w-0 flex-[1_1_12rem]"
              aria-describedby="admin-user-search-hint"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
            />
            <Button type="submit" variant="outline" className="shrink-0">
              {t('admin.users.search')}
            </Button>
          </div>
          <SupportText id="admin-user-search-hint" className="mt-2">{t('admin.users.searchPlaceholder')}</SupportText>
        </form>

        <div role="status" aria-atomic="true" className="mb-3 text-std-17N-170 text-solid-gray-700">
          {usersQuery.isFetching ? (
            <div className="flex items-center gap-2">
              <InlineSpinner color="blue" />
              {t('common.messages.loading')}
            </div>
          ) : !usersQuery.isError ? pageLabel : null}
        </div>
        {usersQuery.isError ? (
          <ErrorMessage message={t('admin.users.loadError')} />
        ) : !isUsersLoading ? (
          <>
            {/* Container-relative rem units keep cards readable with enlarged text, too. */}
            <div className="@min-[60rem]:overflow-hidden @min-[60rem]:rounded-8 @min-[60rem]:border @min-[60rem]:border-solid-gray-300">
              <Table role="table" className="block @min-[60rem]:table @min-[60rem]:table-fixed">
                <caption className="sr-only">{t('admin.users.title')}</caption>
                <TableHeader role="rowgroup" className="hidden bg-solid-gray-50 @min-[60rem]:table-header-group">
                  <TableRow role="row">
                    <TableHead role="columnheader" className="py-3">{t('admin.users.columns.user')}</TableHead>
                    <TableHead role="columnheader" className="w-48 py-3">{t('admin.users.columns.flags')}</TableHead>
                    <TableHead role="columnheader" className="w-56 py-3">{t('admin.users.columns.quota')}</TableHead>
                    <TableHead role="columnheader" className="w-44 py-3">{t('admin.users.columns.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody role="rowgroup" className="block space-y-4 @min-[60rem]:table-row-group @min-[60rem]:space-y-0">
                  {visibleUsers.map((row) => {
                    const identityId = `${usersTableId}-${row.id}`;
                    const isDeleting = pendingDeleteIds.has(row.id);
                    return (
                      <TableRow role="row" key={row.id} className="block rounded-8 border border-solid-gray-300 bg-white @min-[60rem]:table-row @min-[60rem]:rounded-none @min-[60rem]:border-x-0 @min-[60rem]:border-t-0 @min-[60rem]:last:border-b-0">
                        <TableHead role="rowheader" scope="row" className="block min-w-0 py-4 font-normal @min-[60rem]:table-cell">
                          <div id={`${identityId}-name`} className="text-std-17B-170 [overflow-wrap:anywhere]">{row.username}</div>
                          <div id={`${identityId}-email`} className="text-dns-14N-130 leading-relaxed text-solid-gray-700 [overflow-wrap:anywhere]">{row.email}</div>
                          <div className="mt-2 text-dns-14N-130 leading-relaxed text-solid-gray-600 [overflow-wrap:anywhere]">
                            {t('admin.users.columns.id')}: <span className="font-mono">{row.id}</span>
                          </div>
                        </TableHead>
                        <TableCell role="cell" className="block py-3 @min-[60rem]:table-cell @min-[60rem]:py-4">
                          <div className="mb-2 text-dns-14B-130 text-solid-gray-700 @min-[60rem]:hidden">{t('admin.users.columns.flags')}</div>
                          <div className="flex flex-wrap gap-2 [&>[data-slot=chip-label]]:max-w-full [&>[data-slot=chip-label]]:text-oln-14N-100">
                            {row.is_active && !isDeleting && (
                              <ChipLabel variant="filled-1" color="green">{t('admin.users.flags.active')}</ChipLabel>
                            )}
                            <ChipLabel variant="filled-1" color={row.is_admin ? 'blue' : undefined}>
                              {t(row.is_admin ? 'admin.users.flags.admin' : 'admin.users.flags.user')}
                            </ChipLabel>
                            {!row.is_active && !isDeleting && (
                              <ChipLabel variant="filled-1" color="red">{t('admin.users.flags.inactive')}</ChipLabel>
                            )}
                            {row.is_over_quota && (
                              <ChipLabel variant="filled-1" color="orange">{t('admin.users.flags.overQuota')}</ChipLabel>
                            )}
                            {isDeleting && (
                              <ChipLabel variant="filled-1">{t('admin.users.deletionPending')}</ChipLabel>
                            )}
                          </div>
                        </TableCell>
                        <TableCell role="cell" className="block py-3 text-dns-14N-130 leading-relaxed @min-[60rem]:table-cell @min-[60rem]:py-4">
                          <div className="mb-2 text-dns-14B-130 text-solid-gray-700 @min-[60rem]:hidden">{t('admin.users.columns.quota')}</div>
                          <dl className="space-y-2">
                            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                              <dt className="text-solid-gray-700">{t('admin.users.quota.upload')}</dt>
                              <dd className="min-w-0 max-w-full text-end font-bold tabular-nums [overflow-wrap:anywhere]">{row.monthly_upload_limit_gb === null ? t('quota.usage.unlimited') : `${row.monthly_upload_limit_gb} GB`}</dd>
                            </div>
                            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                              <dt className="text-solid-gray-700">{t('admin.users.quota.storage')}</dt>
                              <dd className="min-w-0 max-w-full text-end font-bold tabular-nums [overflow-wrap:anywhere]">
                                {row.storage_limit_gb == null ? t('admin.users.unlimited') : `${row.storage_limit_gb} GB`}
                              </dd>
                            </div>
                          </dl>
                        </TableCell>
                        <TableCell role="cell" className="block border-t border-solid-gray-200 py-3 @min-[60rem]:table-cell @min-[60rem]:border-t-0 @min-[60rem]:py-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="min-w-0 shrink-0"
                              aria-describedby={`${identityId}-name ${identityId}-email`}
                              disabled={isDeleting}
                              onClick={(event) => openEditUser(row, event.currentTarget)}
                            >
                              {t('admin.users.edit')}
                            </Button>
                            <Button
                              type="button"
                              variant="text"
                              size="sm"
                              className="min-w-0 shrink-0 text-red-900 hover:bg-red-50 hover:text-red-1000"
                              aria-describedby={`${identityId}-name ${identityId}-email`}
                              disabled={row.is_admin || row.id === user.id || isDeleting || deleteMutation.isPending}
                              onClick={(event) => {
                                userActionTriggerRef.current = event.currentTarget;
                                setUserToDelete(row);
                                setIsDeleteOpen(true);
                              }}
                            >
                              {t('admin.users.delete')}
                            </Button>
                          </div>
                        {isOnprem && <ResetUserAccessButton id={String(row.id)} username={row.username} />}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </>
        ) : null}
        {/* Keep the focused control mounted through page loads and errors. */}
        <div className="mt-4 flex flex-wrap justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            aria-disabled={!canPrev || usersQuery.isFetching}
            onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
          >
            {t('admin.users.prev')}
          </Button>
          <Button
            type="button"
            variant="outline"
            aria-disabled={!canNext || usersQuery.isFetching}
            onClick={() => setOffset((value) => value + PAGE_SIZE)}
          >
            {t('admin.users.next')}
          </Button>
        </div>
      </section>

      <section className={`${SECTION_CLASS} mt-10`}>
        <Heading size="32" className="text-std-24B-150 md:text-std-32B-150 mb-4">
          <HeadingTitle level="h2">{t('admin.reindex.title')}</HeadingTitle>
        </Heading>
        <SupportText className="mb-4">{t('admin.reindex.description')}</SupportText>
        <Button type="button" variant="outline" onClick={() => setIsReindexOpen(true)}>
          {t('admin.reindex.button')}
        </Button>
      </section>

      <Dialog {...editDialog.dialogProps} onClose={restoreUserListFocus} width="min(42rem, 92vw)">
        <DialogContent>
          <DialogHeader>
            <DialogHeading {...editDialog.headingProps}>
              {selectedUser
                ? t('admin.users.editTitle', { username: selectedUser.username })
                : t('admin.users.edit')}
            </DialogHeading>
          </DialogHeader>
          <DialogBody>
            {formError && (
              <div ref={formErrorRef} tabIndex={-1} className="mb-4 [overflow-wrap:anywhere]">
                <ErrorMessage message={formError} />
              </div>
            )}
            <fieldset disabled={saveMutation.isPending} className="@container min-w-0 space-y-6">
              <fieldset className="space-y-2">
                <legend className="mb-1 text-std-17B-170 text-solid-gray-800">
                  {t('admin.users.columns.flags')}
                </legend>
                <label className="flex items-center gap-2 text-std-17N-170 text-solid-gray-800">
                  <input
                    type="checkbox"
                    checked={isActive}
                    disabled={selectedUser?.id === user.id}
                    onChange={(event) => setIsActive(event.target.checked)}
                  />
                  {t('admin.users.fields.isActive')}
                </label>
                <label className="flex items-center gap-2 text-std-17N-170 text-solid-gray-800">
                  <input
                    type="checkbox"
                    checked={isAdminFlag}
                    disabled={selectedUser?.id === user.id}
                    onChange={(event) => setIsAdminFlag(event.target.checked)}
                  />
                  {t('admin.users.fields.isAdmin')}
                </label>
                {selectedUser?.id === user.id && (
                  <SupportText>{t('admin.users.selfFlagsHint')}</SupportText>
                )}
              </fieldset>
              <div className="grid grid-cols-1 gap-4 @min-[32rem]:grid-cols-2">
                <FormField
                  id={FIELD_IDS.monthly_upload_limit_gb}
                  name="monthly_upload_limit_gb"
                  label={t('admin.users.fields.monthlyUploadGb')}
                  type="text"
                  blockSize="md"
                  className="min-w-0"
                  value={monthlyUploadGb}
                  error={fieldErrors.monthly_upload_limit_gb}
                  onChange={(event) => setMonthlyUploadGb(event.target.value)}
                  supportText={t('admin.users.nullableHint')}
                />
                <FormField
                  id={FIELD_IDS.storage_limit_gb}
                  name="storage_limit_gb"
                  label={t('admin.users.fields.storageLimitGb')}
                  type="text"
                  blockSize="md"
                  className="min-w-0"
                  value={storageLimitGb}
                  error={fieldErrors.storage_limit_gb}
                  onChange={(event) => setStorageLimitGb(event.target.value)}
                  supportText={t('admin.users.nullableHint')}
                />
                <FormField
                  id={FIELD_IDS.processing_limit_minutes}
                  name="processing_limit_minutes"
                  label={t('admin.users.fields.processingLimitMinutes')}
                  type="text"
                  blockSize="md"
                  className="min-w-0"
                  value={processingLimitMinutes}
                  error={fieldErrors.processing_limit_minutes}
                  onChange={(event) => setProcessingLimitMinutes(event.target.value)}
                  supportText={t('admin.users.nullableHint')}
                />
                <FormField
                  id={FIELD_IDS.ai_answers_limit}
                  name="ai_answers_limit"
                  label={t('admin.users.fields.aiAnswersLimit')}
                  type="text"
                  blockSize="md"
                  className="min-w-0"
                  value={aiAnswersLimit}
                  error={fieldErrors.ai_answers_limit}
                  onChange={(event) => setAiAnswersLimit(event.target.value)}
                  supportText={t('admin.users.nullableHint')}
                />
                <FormField
                  id={FIELD_IDS.used_storage_bytes}
                  name="used_storage_bytes"
                  label={t('admin.users.fields.usedStorageBytes')}
                  type="text"
                  blockSize="md"
                  className="min-w-0"
                  value={usedStorageBytes}
                  error={fieldErrors.used_storage_bytes}
                  onChange={(event) => setUsedStorageBytes(event.target.value)}
                />
                <FormField
                  id={FIELD_IDS.used_processing_seconds}
                  name="used_processing_seconds"
                  label={t('admin.users.fields.usedProcessingSeconds')}
                  type="text"
                  blockSize="md"
                  className="min-w-0"
                  value={usedProcessingSeconds}
                  error={fieldErrors.used_processing_seconds}
                  onChange={(event) => setUsedProcessingSeconds(event.target.value)}
                />
                <FormField
                  id={FIELD_IDS.used_ai_answers}
                  name="used_ai_answers"
                  label={t('admin.users.fields.usedAiAnswers')}
                  type="text"
                  blockSize="md"
                  className="min-w-0"
                  value={usedAiAnswers}
                  error={fieldErrors.used_ai_answers}
                  onChange={(event) => setUsedAiAnswers(event.target.value)}
                />
              </div>
              <label className="flex items-center gap-2 text-std-17N-170 text-solid-gray-800">
                <input
                  type="checkbox"
                  checked={isOverQuota}
                  onChange={(event) => setIsOverQuota(event.target.checked)}
                />
                {t('admin.users.fields.isOverQuota')}
              </label>
            </fieldset>
          </DialogBody>
          <DialogActions>
            <Button
              type="button"
              variant="text"
              disabled={saveMutation.isPending}
              onClick={editDialog.closeButtonProps.onClick}
            >
              {t('admin.users.cancel')}
            </Button>
            {/* Preserve keyboard focus while Button blocks repeat submissions. */}
            <Button
              type="button"
              aria-disabled={saveMutation.isPending}
              aria-busy={saveMutation.isPending}
              onClick={saveUser}
            >
              {saveMutation.isPending && <InlineSpinner />}
              {t('admin.users.save')}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>

      <Dialog {...deleteDialog.dialogProps} onClose={restoreUserListFocus} width="min(32rem, 92vw)">
        <DialogContent>
          <DialogHeader>
            <DialogHeading {...deleteDialog.headingProps}>
              {userToDelete
                ? t('admin.users.deleteTitle', { username: userToDelete.username })
                : t('admin.users.delete')}
            </DialogHeading>
          </DialogHeader>
          <DialogBody>
            <p className="text-std-17N-170 text-solid-gray-800">
              {t('admin.users.deleteBody')}
            </p>
          </DialogBody>
          <DialogActions>
            <Button
              type="button"
              variant="text"
              disabled={deleteMutation.isPending}
              onClick={deleteDialog.closeButtonProps.onClick}
            >
              {t('admin.users.cancel')}
            </Button>
            <Button
              type="button"
              aria-disabled={deleteMutation.isPending}
              aria-busy={deleteMutation.isPending}
              onClick={() => { if (userToDelete) deleteMutation.mutate(userToDelete); }}
            >
              {deleteMutation.isPending && <InlineSpinner />}
              {t('admin.users.deleteConfirm')}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>

      <Dialog {...reindexDialog.dialogProps} width="min(32rem, 92vw)">
        <DialogContent>
          <DialogHeader>
            <DialogHeading {...reindexDialog.headingProps}>
              {t('admin.reindex.confirmTitle')}
            </DialogHeading>
          </DialogHeader>
          <DialogBody>
            <p className="text-std-17N-170 text-solid-gray-800">
              {t('admin.reindex.confirmBody')}
            </p>
          </DialogBody>
          <DialogActions>
            <Button
              type="button"
              variant="text"
              disabled={reindexMutation.isPending}
              onClick={reindexDialog.closeButtonProps.onClick}
            >
              {t('admin.users.cancel')}
            </Button>
            <Button
              type="button"
              aria-disabled={reindexMutation.isPending}
              aria-busy={reindexMutation.isPending}
              onClick={() => reindexMutation.mutate()}
            >
              {reindexMutation.isPending && <InlineSpinner />}
              {t('admin.reindex.confirm')}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </>
  );
}
