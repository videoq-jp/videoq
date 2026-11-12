import { features } from "@/lib/deployment";
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { apiClient } from '@/lib/api';
import { trpc } from '@/lib/trpc';
import { refreshQuery } from '@/lib/cacheInvalidation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SupportText } from '@/components/ui/support-text';
import { Heading, HeadingTitle } from '@/components/ui/heading';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import { MessageAlert } from '@/components/common/MessageAlert';

const USERNAME_ERRORS: Record<string, string> = {
  USERNAME_IS_ALREADY_TAKEN: 'settings.usernameChange.errorTaken',
  USERNAME_TOO_SHORT: 'settings.usernameChange.errorTooShort',
  USERNAME_TOO_LONG: 'settings.usernameChange.errorTooLong',
  INVALID_USERNAME: 'settings.usernameChange.errorInvalid',
};

function AccountField({ field, currentValue }: { field: 'username' | 'email'; currentValue: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const wasEditing = useRef(false);
  const prefix = field === 'username' ? 'settings.usernameChange' : 'settings.emailChange';
  const id = `account-${field}`;
  const trimmedValue = value.trim();
  const unchanged = trimmedValue.toLowerCase() === currentValue.toLowerCase();

  useEffect(() => {
    if (editing) input.current?.focus();
    else if (wasEditing.current) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const update = useMutation({
    mutationFn: async (nextValue: string) => {
      if (field === 'username') await apiClient.updateUsername({ username: nextValue });
      else await apiClient.requestEmailChange({ email: nextValue });
    },
    onSuccess: async () => {
      if (field === 'username') await refreshQuery(queryClient, trpc.account.me.pathFilter());
      setStatus({ tone: 'success', text: t(`${prefix}.success`) });
      setEditing(false);
      setValue('');
    },
    onError: (error) => {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      setStatus({
        tone: 'error',
        text: field === 'username' && USERNAME_ERRORS[code]
          ? t(USERNAME_ERRORS[code])
          : error instanceof Error && error.message ? error.message : t(`${prefix}.errorSubmitting`),
      });
    },
  });

  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-std-17B-170">{t(`${prefix}.title`)}</h3>
          <p className="break-all text-std-17N-170 text-solid-gray-700">
            {currentValue || t('common.notProvided')}
          </p>
        </div>
        {(field === "username" || features.emailDelivery) && <Button
          ref={editButton}
          type="button"
          variant="text"
          size="sm"
          className="shrink-0"
          aria-label={editing ? `${t('settings.cancel')}: ${t(`${prefix}.title`)}` : t(`${prefix}.edit`)}
          aria-expanded={editing}
          aria-controls={`${id}-editor`}
          disabled={update.isPending}
          onClick={() => {
            setStatus(null);
            setValue(currentValue);
            setEditing(!editing);
          }}
        >
          {editing ? t('settings.cancel') : t('settings.edit')}
        </Button>}
      </div>
      {status && <div className="mt-4"><MessageAlert type={status.tone} message={status.text} /></div>}
      <div id={`${id}-editor`}>
        {editing && (
          <form
            className="mt-4 space-y-4 rounded-8 bg-solid-gray-50 p-4 sm:p-5"
            aria-label={t(`${prefix}.edit`)}
            onSubmit={(event) => {
              event.preventDefault();
              if (update.isPending || unchanged) return;
              if (!trimmedValue) {
                setStatus({ tone: 'error', text: t(`${prefix}.errorEmpty`) });
                return;
              }
              setStatus(null);
              update.mutate(trimmedValue);
            }}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor={id}>
                {t(field === 'username' ? 'settings.usernameChange.newUsernameLabel' : 'settings.emailChange.newEmailLabel')}
              </Label>
              <Input
                ref={input}
                id={id}
                type={field === 'email' ? 'email' : 'text'}
                autoComplete={field}
                autoCapitalize="none"
                spellCheck={false}
                value={value}
                disabled={update.isPending}
                aria-describedby={`${id}-help`}
                onChange={(event) => setValue(event.target.value)}
              />
              <SupportText id={`${id}-help`}>{t(`${prefix}.help`)}</SupportText>
            </div>
            <div className="flex flex-wrap justify-end gap-3">
              <Button type="button" variant="outline" disabled={update.isPending} onClick={() => {
                setStatus(null);
                setEditing(false);
              }}>
                {t('settings.cancel')}
              </Button>
              <Button type="submit" disabled={update.isPending || !trimmedValue || unchanged}>
                {update.isPending && <InlineSpinner className="mr-1 h-4 w-4" />}
                {t(`${prefix}.${update.isPending ? 'submitting' : 'submit'}`)}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export function AccountSettingsSection() {
  const { user } = useAuth();
  const { t } = useTranslation();
  return (
    <section id="account" aria-labelledby="account-heading" className="scroll-mt-24">
      <Heading size="32" className="text-std-24B-150 md:text-std-32B-150 mb-4">
        <HeadingTitle id="account-heading" level="h2">{t('settings.account.title')}</HeadingTitle>
      </Heading>
      <div className="divide-y divide-solid-gray-200">
        <AccountField field="username" currentValue={user?.username ?? ''} />
        <AccountField field="email" currentValue={user?.email ?? ''} />
      </div>
    </section>
  );
}
