import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthPageIntro } from '@/components/layout/AuthPageIntro';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ErrorMessage } from '@/components/auth/ErrorMessage';
import { Link, useLocale } from '@/lib/i18n';
import { useAuthSession } from '@/lib/authSession';
import { getSafeNextPath } from '@/lib/authRedirect';
import { completeSignupTracking } from '@/lib/landingAnalytics';

export default function SignupCompletePage({ method }: { method: 'google' | 'email' }) {
  const session = useAuthSession();
  const navigate = useNavigate();
  const locale = useLocale();
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const callbackFailed = params.has('error');
  const fallback = locale === 'en' ? '/en/' : '/';
  const requestedNext = getSafeNextPath(params.get('next'));
  const next = requestedNext && !/^\/(?:en\/)?signup\/(?:complete|verified)(?:[/?#]|$)/.test(requestedNext)
    ? requestedNext : fallback;
  const userId = session.data?.user.id;
  const verificationReady = method === 'google' || session.data?.user.emailVerified === true;

  useEffect(() => {
    if (callbackFailed || session.isPending || session.error || !userId || !verificationReady) return;
    completeSignupTracking(method);
    navigate(next, { replace: true });
  }, [callbackFailed, session.isPending, session.error, userId, verificationReady, method, navigate, next]);

  if (callbackFailed || (!session.isPending && (session.error || !userId || !verificationReady))) {
    return (
      <div className="space-y-6">
        <AuthPageIntro badge={t('auth.verifyEmail.badge')} title={t('auth.verifyEmail.title')} />
        <ErrorMessage message={t(method === 'google' ? 'auth.login.oauthCallbackFailed' : 'auth.verifyEmail.error')} />
        <Link href="/login">{t('auth.verifyEmail.backToLogin')}</Link>
      </div>
    );
  }
  return <LoadingSpinner />;
}
