import { useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Send } from 'lucide-react';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import { apiClient } from '@/lib/api';
import { AuthPageIntro } from '@/components/layout/AuthPageIntro';
import { FormField } from '@/components/auth/FormField';
import { ErrorMessage } from '@/components/auth/ErrorMessage';
import { MessageAlert } from '@/components/common/MessageAlert';
import { AuthFormFooter } from '@/components/auth/AuthFormFooter';
import { Button } from '@/components/ui/button';
import { UtilityLink } from '@/components/ui/utility-link';

export default function ForgotPasswordPage() {
  const { t } = useTranslation();
  const submitInFlightRef = useRef(false);
  const requestResetMutation = useMutation({
    mutationFn: (email: string) => apiClient.requestPasswordReset({ email }),
    onSettled: () => { submitInFlightRef.current = false; },
  });

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitInFlightRef.current) return;
    const emailEntry = new FormData(event.currentTarget).get('email');
    const email = typeof emailEntry === 'string' ? emailEntry : '';
    submitInFlightRef.current = true;
    requestResetMutation.mutate(email);
  };

  return (
    <>
      <UtilityLink asChild className="mb-12 inline-flex items-center">
        <Link href="/login">
          <ArrowLeft className="mr-2 w-4 h-4" />
          {t('auth.forgotPassword.backToLogin')}
        </Link>
      </UtilityLink>

      <div className="space-y-6">
        <AuthPageIntro
          badge={t('auth.forgotPassword.badge')}
          title={t('auth.forgotPassword.title')}
          description={t('auth.forgotPassword.description')}
        />

        {requestResetMutation.isSuccess && <MessageAlert type="success" message={t('auth.forgotPassword.success')} />}
        <ErrorMessage message={requestResetMutation.error?.message ?? null} />

        <form onSubmit={handleSubmit} className="space-y-5">
          <FormField
            id="email"
            name="email"
            label={t('auth.fields.email.label')}
            type="email"
            required
            disabled={requestResetMutation.isPending}
            autoComplete="email"
          />

          <Button
            type="submit"
            variant="solid"
            size="lg"
            className="w-full"
            disabled={requestResetMutation.isPending}
          >
            {requestResetMutation.isPending ? (
              <>
                <InlineSpinner className="w-4 h-4" />
                {t('auth.forgotPassword.submitting')}
              </>
            ) : (
              <>
                {t('auth.forgotPassword.submit')}
                <Send className="w-4 h-4 ml-2" />
              </>
            )}
          </Button>
        </form>

        <div className="pt-8">
          <AuthFormFooter
            questionText={t('auth.forgotPassword.noAccount')}
            linkText={t('auth.forgotPassword.signUp')}
            href="/signup"
          />
        </div>
      </div>

    </>
  );
}
