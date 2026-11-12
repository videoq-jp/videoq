import { useEffect } from 'react';
import { Link, useI18nNavigate } from '@/lib/i18n';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { AuthPageIntro } from '@/components/layout/AuthPageIntro';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import { MessageAlert } from '@/components/common/MessageAlert';
import { UtilityLink } from '@/components/ui/utility-link';
import { useVerifyEmailQuery } from '@/hooks/useVerifyEmailData';
import { trackLandingEvent } from '@/lib/landingAnalytics';

type VerificationState = 'loading' | 'success' | 'error';

export default function VerifyEmailPage() {
  const navigate = useI18nNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const { t } = useTranslation();
  const { verifyQuery, isInvalidLink } = useVerifyEmailQuery({ token });

  useEffect(() => {
    if (isInvalidLink || !verifyQuery.isSuccess) {
      return;
    }

    trackLandingEvent('email_verified');
    const timer = setTimeout(() => {
      navigate('/login', { replace: true });
    }, 2000);

    return () => {
      clearTimeout(timer);
    };
  }, [isInvalidLink, navigate, verifyQuery.isSuccess]);

  let state: VerificationState;
  let message: string;

  if (isInvalidLink) {
    state = 'error';
    message = t('auth.verifyEmail.invalidLink');
  } else if (verifyQuery.isPending) {
    state = 'loading';
    message = t('auth.verifyEmail.loading');
  } else if (verifyQuery.isSuccess) {
    state = 'success';
    message = t('auth.verifyEmail.success');
  } else {
    state = 'error';
    message = verifyQuery.error instanceof Error ? verifyQuery.error.message : t('auth.verifyEmail.error');
  }

  return (
    <>
      <UtilityLink asChild className="mb-12 inline-flex items-center text-std-17N-170 font-bold">
        <Link href="/login">
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('auth.verifyEmail.backToLogin')}
        </Link>
      </UtilityLink>

      <div className="space-y-6">
        <AuthPageIntro
          badge={t('auth.verifyEmail.badge')}
          title={t('auth.verifyEmail.title')}
          description={t('auth.verifyEmail.description')}
        />

        {state === 'loading' && (
          <div className="flex items-center gap-3 rounded-8 border border-solid-gray-300 bg-solid-gray-50 p-4">
            <InlineSpinner color="blue" />
            <span className="text-std-17N-170 text-solid-gray-700">{message}</span>
          </div>
        )}

        {state === 'success' && (
          <div className="space-y-4">
            <MessageAlert type="success" message={message} />
            <p className="text-center text-std-17N-170 text-solid-gray-600">
              {t('auth.verifyEmail.redirectPart1')}{' '}
              <UtilityLink asChild>
                <Link href="/login">{t('auth.verifyEmail.redirectLink')}</Link>
              </UtilityLink>
            </p>
          </div>
        )}

        {state === 'error' && (
          <div className="space-y-4">
            <MessageAlert type="error" message={message} />
            <div className="space-y-2 text-std-17N-170 text-solid-gray-600">
              <p>{t('auth.verifyEmail.retry')}</p>
              <UtilityLink asChild>
                <Link href="/login">{t('auth.verifyEmail.backToLogin')}</Link>
              </UtilityLink>
            </div>
          </div>
        )}
      </div>

    </>
  );
}
