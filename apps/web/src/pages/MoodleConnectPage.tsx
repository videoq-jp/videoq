import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { AuthPageIntro } from '@/components/layout/AuthPageIntro';
import { MessageAlert } from '@/components/common/MessageAlert';
import { InlineLoading } from '@/components/common/InlineLoading';
import { Button } from '@/components/ui/button';
import { API_URL } from '@/lib/apiConfig';
import { useAuthSession } from '@/lib/authSession';
import { useI18nNavigate } from '@/lib/i18n';
import { moodleConnectCallback, moodleConnectRequest, returnToMoodle } from '@/lib/moodleConnect';

export default function MoodleConnectPage() {
  const { t } = useTranslation();
  const session = useAuthSession();
  const navigate = useI18nNavigate();
  const location = useLocation();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = moodleConnectRequest(location.search);
  async function approve() {
    if (!request) return;
    setPending(true); setFailed(false);
    try {
      const response = await fetch(API_URL.replace(/\/+$/, '') + '/lms/pairing', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moodleUrl: request.moodleUrl, codeChallenge: request.codeChallenge }),
      });
      if (!response.ok) throw new Error();
      const result = await response.json() as { code?: string };
      if (!result.code?.startsWith('VIDEOQ2.')) throw new Error();
      const code = (JSON.parse(atob(result.code.slice(8))) as { secret?: string }).secret;
      if (!code || !/^[a-f0-9]{64}$/.test(code)) throw new Error();
      returnToMoodle(moodleConnectCallback(request, { code }));
    } catch { setFailed(true); setPending(false); }
  }
  return <>
    <AuthPageIntro badge="Moodle" title={t('auth.moodleConnect.title')} />
    {!request ? <MessageAlert type="error" message={t('auth.moodleConnect.invalid')} />
      : session.isPending ? <InlineLoading message={t('auth.moodleConnect.loading')} />
      : session.error && session.error.status !== 401 ? <MessageAlert type="error" message={t('auth.moodleConnect.error')} />
      : !session.data?.user ? <>
        <p className="mb-4">{t('auth.moodleConnect.loginHelp')}</p>
        <p className="mb-6 break-all">{request.moodleUrl}</p>
        <Button onClick={() => navigate('/login?next=' + encodeURIComponent(location.pathname + location.search))}>{t('auth.moodleConnect.login')}</Button>
      </> : <>
        <p className="mb-4">{t('auth.moodleConnect.account', { account: session.data.user.email })}</p>
        <p className="mb-4 break-all font-bold">{request.moodleUrl}</p>
        <p className="mb-6">{t('auth.moodleConnect.permissions')}</p>
        {failed && <MessageAlert className="mb-4" type="error" message={t('auth.moodleConnect.error')} />}
        <div className="flex flex-col gap-3">
          <Button disabled={pending} onClick={() => void approve()}>{t(pending ? 'auth.moodleConnect.connecting' : 'auth.moodleConnect.allow')}</Button>
          <Button variant="outline" disabled={pending} onClick={() => returnToMoodle(moodleConnectCallback(request, { error: 'access_denied' }))}>{t('auth.moodleConnect.cancel')}</Button>
        </div>
      </>}
  </>;
}
