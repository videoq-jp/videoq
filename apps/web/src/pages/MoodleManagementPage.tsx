import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { moodleManagementContext, parseMoodleManagementSearch } from '@videoq/trpc/moodle-management';
import { AuthPageIntro } from '@/components/layout/AuthPageIntro';
import { MessageAlert } from '@/components/common/MessageAlert';
import { InlineLoading } from '@/components/common/InlineLoading';
import { Button } from '@/components/ui/button';
import { Link as DaLink } from '@/components/ui/link';
import { API_URL } from '@/lib/apiConfig';
import { authClient } from '@/lib/auth-client';
import { useAuthSession } from '@/lib/authSession';
import { features } from '@/lib/deployment';
import { Link, useI18nNavigate } from '@/lib/i18n';

class ContextError extends Error {
  readonly status: number;
  constructor(status: number) { super('Moodle management context unavailable'); this.status = status; }
}

export default function MoodleManagementPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useI18nNavigate();
  const session = useAuthSession();
  const [switching, setSwitching] = useState(false);
  const [switchFailed, setSwitchFailed] = useState(false);
  const request = parseMoodleManagementSearch(location.search);
  const userId = session.data?.user.id;
  const context = useQuery({
    queryKey: ['moodleManagement', userId, request],
    enabled: Boolean(request && userId && !session.isPending && !session.error),
    retry: false,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const response = await fetch(API_URL.replace(/\/+$/, '') + '/lms/pairing/management', {
        method: 'POST', credentials: 'include', signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
      });
      if (!response.ok) throw new ContextError(response.status);
      return moodleManagementContext.parse(await response.json());
    },
  });
  const signIn = () => navigate('/login?next=' + encodeURIComponent(location.pathname + location.search));
  async function switchAccount() {
    setSwitching(true); setSwitchFailed(false);
    try {
      const result = await authClient.signOut();
      if (result?.error) throw new Error();
      signIn();
    } catch { setSwitchFailed(true); setSwitching(false); }
  }
  const authenticationError = context.error instanceof ContextError && context.error.status === 401;
  const sessionUnavailable = session.error && ![401, 403].includes(session.error.status);
  const data = !context.isFetching && !switching ? context.data : undefined;
  const links = data?.permissions.account ? [
    { href: '/videos', label: 'library' },
    { href: '/videos/courses', label: 'courses' },
    { href: '/settings#account', label: 'account' },
    { href: '/settings#integrations', label: 'integrations' },
    ...(features.youtube ? [{ href: '/settings#youtube', label: 'searchKey' }] : []),
    ...(features.billing && data.permissions.billing ? [{ href: '/settings#billing', label: 'billing' }] : []),
  ] : [];
  if (data?.permissions.systemAdmin) links.push({ href: '/admin', label: 'admin' });
  return <>
    <AuthPageIntro badge="Moodle" title={t('auth.moodleManagement.title')} />
    {!request ? <MessageAlert type="error" message={t('auth.moodleManagement.invalid')} />
      : session.isPending ? <InlineLoading message={t('auth.moodleManagement.loading')} />
      : sessionUnavailable ? <MessageAlert type="error" message={t('auth.moodleManagement.error')} />
      : !userId || authenticationError || (session.error && [401, 403].includes(session.error.status)) ? <>
        <p className="mb-4">{t('auth.moodleManagement.loginHelp')}</p>
        <Button onClick={signIn}>{t('auth.moodleConnect.login')}</Button>
      </> : <>
        <p className="mb-3 break-all">{request.issuer}</p>
        <p className="mb-4 break-all">{t('auth.moodleManagement.signedIn', { account: session.data?.user.email })}</p>
        <p className="mb-6">{t('auth.moodleManagement.authority')}</p>
        {context.isPending || context.isFetching ? <InlineLoading message={t('auth.moodleManagement.loading')} />
          : context.isError ? <div className="space-y-3">
            <MessageAlert type="error" message={t('auth.moodleManagement.error')} />
            <Button variant="outline" onClick={() => void context.refetch()}>{t('auth.moodleManagement.retry')}</Button>
          </div> : data && <>
            {!data.connection.owned ? <MessageAlert className="mb-4" type="warning" message={t('auth.moodleManagement.notOwner')} />
              : !data.connection.active ? <MessageAlert className="mb-4" type="warning" role="status" message={t('auth.moodleManagement.inactive')} /> : null}
            {links.length > 0 && <nav aria-label={t('auth.moodleManagement.navigation')}>
              <ul className="mb-6 space-y-3">
                {links.map(link => <li key={link.label}><DaLink asChild><Link href={link.href}>{t('auth.moodleManagement.' + link.label)}</Link></DaLink></li>)}
              </ul>
            </nav>}
          </>}
        {switchFailed && <MessageAlert className="mb-3" type="error" message={t('auth.moodleManagement.error')} />}
        <Button variant="outline" disabled={switching} onClick={() => void switchAccount()}>{t('auth.moodleManagement.switchAccount')}</Button>
      </>}
  </>;
}
