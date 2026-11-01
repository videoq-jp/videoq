import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@/lib/i18n';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { AuthPageIntro } from '@/components/layout/AuthPageIntro';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import { apiClient } from '@/lib/api';
import { PASSWORD_MIN_LENGTH } from '@/lib/authConfig';
import { FormField } from '@/components/auth/FormField';
import { ErrorMessage } from '@/components/auth/ErrorMessage';
import { MessageAlert } from '@/components/common/MessageAlert';
import { Button } from '@/components/ui/button';
import { UtilityLink } from '@/components/ui/utility-link';

function ResetPasswordContent({ token }: { token: string }) {
  const { t } = useTranslation();

  const [clientError, setClientError] = useState<string | null>(null);
  const submitInFlightRef = useRef(false);

  const resetPasswordMutation = useMutation({
    mutationFn: (newPassword: string) => apiClient.confirmPasswordReset({ token, new_password: newPassword }),
    onSettled: () => { submitInFlightRef.current = false; },
  });
  const error = !token
    ? t('auth.resetPassword.invalidLink')
    : clientError ?? resetPasswordMutation.error?.message ?? null;

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitInFlightRef.current) return;
    setClientError(null);
    const data = new FormData(event.currentTarget);
    const passwordEntry = data.get('password');
    const confirmationEntry = data.get('confirmPassword');
    const password = typeof passwordEntry === 'string' ? passwordEntry : '';
    const confirmPassword = typeof confirmationEntry === 'string' ? confirmationEntry : '';

    if (password !== confirmPassword) {
      setClientError(t('auth.resetPassword.passwordMismatch'));
      return;
    }

    submitInFlightRef.current = true;
    resetPasswordMutation.mutate(password);
  };

  return (
    <>
      <UtilityLink asChild className="mb-12 inline-flex items-center">
        <Link href="/login">
          <ArrowLeft className="mr-2 w-4 h-4" />
          {t('auth.resetPassword.backToLogin')}
        </Link>
      </UtilityLink>

      <div className="space-y-6">
        <AuthPageIntro
          badge={t('auth.resetPassword.badge')}
          title={t('auth.resetPassword.title')}
          description={t('auth.resetPassword.description')}
        />

        <ErrorMessage message={error} />
        {resetPasswordMutation.isSuccess && <MessageAlert type="success" message={t('auth.resetPassword.success')} />}

        {token && !resetPasswordMutation.isSuccess && <form onSubmit={handleSubmit} className="space-y-5">
          <FormField
            id="password"
            name="password"
            label={t('auth.resetPassword.newPassword')}
            type="password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            supportText={t('auth.fields.password.minLengthHint', {
              min: PASSWORD_MIN_LENGTH,
            })}
            disabled={resetPasswordMutation.isPending}
            autoComplete="new-password"
          />

          <FormField
            id="confirmPassword"
            name="confirmPassword"
            label={t('auth.resetPassword.confirmPassword')}
            type="password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            disabled={resetPasswordMutation.isPending}
            autoComplete="new-password"
          />

          <Button
            type="submit"
            variant="solid"
            size="lg"
            className="w-full"
            disabled={resetPasswordMutation.isPending}
          >
            {resetPasswordMutation.isPending ? (
              <>
                <InlineSpinner className="w-4 h-4" />
                {t('auth.resetPassword.submitting')}
              </>
            ) : (
              t('auth.resetPassword.submit')
            )}
          </Button>
        </form>}

        {resetPasswordMutation.isSuccess && (
          <div className="text-center">
            <UtilityLink asChild>
              <Link href="/login">{t('auth.resetPassword.backToLogin')}</Link>
            </UtilityLink>
          </div>
        )}
      </div>

    </>
  );
}

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.has('error') ? '' : searchParams.get('token') ?? '';
  return <ResetPasswordContent key={token} token={token} />;
}
