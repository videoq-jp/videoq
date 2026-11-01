import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MessageAlert } from '@/components/common/MessageAlert';

function ActivationLink({ url, clear }: { url: string; clear: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); } catch { setCopied(false); }
  };
  return <div className="my-4 space-y-3 rounded-8 bg-solid-gray-50 p-4">
    <p>{t('onprem.activationHelp')}</p>
    <Input aria-label={t('onprem.activationLink')} value={url} readOnly onFocus={event => event.currentTarget.select()} />
    <div className="flex gap-3">
      <Button type="button" variant="outline" onClick={() => { void handleCopy(); }}>{t(copied ? 'onprem.copied' : 'onprem.copyLink')}</Button>
      <Button type="button" variant="text" onClick={clear}>{t('common.actions.close')}</Button>
    </div>
  </div>;
}

export function OnpremUserProvisioning() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const create = useMutation(trpc.admin.createUser.mutationOptions({ onSuccess: async () => {
    setEmail(''); setUsername('');
    await queryClient.invalidateQueries(trpc.admin.listUsers.pathFilter());
  } }));
  return <details className="mb-6 rounded-8 border border-solid-gray-420 p-4">
    <summary className="cursor-pointer font-bold">{t('onprem.addUser')}</summary>
    <form className="mt-4 max-w-xl space-y-4" onSubmit={event => {
      event.preventDefault(); create.mutate({ email: email.trim(), username: username.trim() });
    }}>
      <div><Label className="mb-2 block" htmlFor="onprem-username">{t('auth.fields.username.label')}</Label>
        <Input className="w-full" blockSize="md" id="onprem-username" value={username} onChange={event => setUsername(event.target.value)} required minLength={3} maxLength={150} pattern="[a-zA-Z0-9_.]+" autoComplete="off" /></div>
      <div><Label className="mb-2 block" htmlFor="onprem-email">{t('auth.fields.email.label')}</Label>
        <Input className="w-full" blockSize="md" id="onprem-email" type="email" value={email} onChange={event => setEmail(event.target.value)} required autoComplete="off" /></div>
      <Button type="submit" variant="solid" disabled={create.isPending}>{t('onprem.createLink')}</Button>
    </form>
    {create.error && <MessageAlert type="error" message={create.error.message} />}
    {create.data && <ActivationLink url={create.data.activation_url} clear={() => create.reset()} />}
  </details>;
}

export function ResetUserAccessButton({ id, username }: { id: string; username: string }) {
  const { t } = useTranslation();
  const reset = useMutation(trpc.admin.resetAccess.mutationOptions());
  return <div>
    <Button type="button" variant="text" size="sm" disabled={reset.isPending}
      aria-label={t('onprem.resetUserAccess', { username })} onClick={() => reset.mutate({ id })}>{t('onprem.resetAccess')}</Button>
    {reset.error && <MessageAlert type="error" message={reset.error.message} />}
    {reset.data && <ActivationLink url={reset.data.activation_url} clear={() => reset.reset()} />}
  </div>;
}
