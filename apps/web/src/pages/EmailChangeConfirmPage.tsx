import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Link } from '@/lib/i18n';
import { apiClient } from '@/lib/api';
import { AuthPageIntro } from '@/components/layout/AuthPageIntro';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import { MessageAlert } from '@/components/common/MessageAlert';
import { UtilityLink } from '@/components/ui/utility-link';

type EmailChangeState = 'loading' | 'pending' | 'success' | 'error';

export default function EmailChangeConfirmPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const errorParam = searchParams.get('error');
  const awaitingVerification = !token && searchParams.get('step') === 'verify-new';
  const { t } = useTranslation();

  // BA verify-email redirects here via callbackURL after success (no token).
  // Token is only present if the SPA is used as a handoff target.
  const confirmQuery = useQuery({
    queryKey: ['emailChangeConfirm', token ?? 'callback', errorParam ?? null],
    enabled: !errorParam && !awaitingVerification,
    retry: false,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (token) {
        return apiClient.confirmEmailChange({ token });
      }
      return { requiresNewEmailVerification: false };
    },
  });

  let state: EmailChangeState;
  let message: string;

  if (errorParam) {
    state = 'error';
    message = t('auth.emailChange.error');
  } else if (awaitingVerification || confirmQuery.data?.requiresNewEmailVerification) {
    state = 'pending';
    message = t('auth.emailChange.pendingVerification');
  } else if (confirmQuery.isPending) {
    state = 'loading';
    message = t('auth.emailChange.loading');
  } else if (confirmQuery.isSuccess) {
    state = 'success';
    message = t('auth.emailChange.success');
  } else {
    state = 'error';
    message = confirmQuery.error instanceof Error
      ? confirmQuery.error.message
      : t('auth.emailChange.error');
  }

  return (
    <>
      <UtilityLink asChild className="mb-12 inline-flex items-center text-std-17N-170 font-bold">
        <Link href="/login">
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('auth.emailChange.backToLogin')}
        </Link>
      </UtilityLink>

      <div className="space-y-6">
        <AuthPageIntro
          badge={t('auth.emailChange.badge')}
          title={t('auth.emailChange.title')}
          description={t('auth.emailChange.description')}
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
              <UtilityLink asChild>
                <Link href="/login">{t('auth.emailChange.backToLogin')}</Link>
              </UtilityLink>
            </p>
          </div>
        )}

        {state === 'pending' && <MessageAlert type="warning" message={message} />}

        {state === 'error' && (
          <div className="space-y-4">
            <MessageAlert type="error" message={message} />
            <UtilityLink asChild>
              <Link href="/login">{t('auth.emailChange.backToLogin')}</Link>
            </UtilityLink>
          </div>
        )}
      </div>

    </>
  );
}
