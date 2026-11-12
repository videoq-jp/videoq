import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Link, useI18nNavigate } from '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { useAuthForm } from '@/hooks/useAuthForm';
import { apiClient } from '@/lib/api';
import { PASSWORD_MIN_LENGTH } from '@/lib/authConfig';
import { getSafeNextPath } from '@/lib/authRedirect';
import { Eye, EyeOff } from 'lucide-react';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import { AuthPageIntro } from '@/components/layout/AuthPageIntro';
import { FormField } from '@/components/auth/FormField';
import { ErrorMessage } from '@/components/auth/ErrorMessage';
import { AuthFormFooter } from '@/components/auth/AuthFormFooter';
import { GoogleSignInButton } from '@/components/auth/GoogleSignInButton';
import { Button } from '@/components/ui/button';
import { Divider } from '@/components/ui/divider';
import { UtilityLink } from '@/components/ui/utility-link';
import { trackLandingEvent } from '@/lib/landingAnalytics';

export default function SignupPage() {
  const navigate = useI18nNavigate();
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const nextPath = getSafeNextPath(searchParams.get('next'));
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  useEffect(() => { trackLandingEvent('signup_view'); }, []);

  const { formData, error, isLoading, handleChange, handleSubmit } = useAuthForm({
    onSubmit: async (data: { username: string; email: string; password: string; confirmPassword: string }) => {
      if (data.password !== data.confirmPassword) {
        throw new Error(t('auth.signup.passwordMismatch'));
      }
      await apiClient.signup({
        username: data.username,
        email: data.email,
        password: data.password,
        ...(nextPath ? { callbackURL: nextPath } : {}),
      });
      trackLandingEvent('email_signup_created');
    },
    initialData: { username: '', email: '', password: '', confirmPassword: '' },
    onSuccessRedirect: () => navigate(
      nextPath ? `/signup/check-email?next=${encodeURIComponent(nextPath)}` : '/signup/check-email',
    ),
  });

  return (
    <>
      <AuthPageIntro badge={t('auth.signup.badge')} title={t('auth.signup.title')} />

      {error && <div className="mb-4"><ErrorMessage message={error} /></div>}

      <p className="mb-6 text-dns-14N-130 text-solid-gray-700">
        {t('auth.signup.legalBefore')}
        <UtilityLink asChild><Link href="/terms">{t('legal.terms.title')}</Link></UtilityLink>
        {t('auth.signup.legalAnd')}
        <UtilityLink asChild><Link href="/privacy">{t('legal.privacy.title')}</Link></UtilityLink>
        {t('auth.signup.legalAfter')}
      </p>

      <GoogleSignInButton
        callbackURL={nextPath || '/'}
        labelKey="auth.signup.continueWithGoogle"
      />

      <div className="my-8 flex items-center gap-4">
        <Divider className="flex-1" aria-hidden="true" />
        <span className="shrink-0 text-dns-14N-130 text-solid-gray-600">
          {t('auth.signup.orDivider')}
        </span>
        <Divider className="flex-1" aria-hidden="true" />
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <FormField
          id="username"
          name="username"
          label={t('auth.fields.username.label')}
          type="text"
          value={formData.username || ''}
          onChange={handleChange}
          required
          autoComplete="username"
        />

        <FormField
          id="email"
          name="email"
          label={t('auth.fields.email.label')}
          type="email"
          value={formData.email || ''}
          onChange={handleChange}
          required
          autoComplete="email"
        />

        <div className="flex flex-col gap-2">
          <FormField
            id="password"
            name="password"
            label={t('auth.fields.password.label')}
            type={showPassword ? 'text' : 'password'}
            value={formData.password || ''}
            onChange={handleChange}
            required
            minLength={PASSWORD_MIN_LENGTH}
            supportText={t('auth.fields.password.minLengthHint', {
              min: PASSWORD_MIN_LENGTH,
            })}
            autoComplete="new-password"
          />
          <Button
            type="button"
            variant="text"
            size="xs"
            className="self-start"
            onClick={() => setShowPassword((prev) => !prev)}
            aria-label={showPassword ? t('auth.fields.password.hide') : t('auth.fields.password.show')}
          >
            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            <span className="ml-1">
              {showPassword ? t('auth.fields.password.hide') : t('auth.fields.password.show')}
            </span>
          </Button>
        </div>

        <div className="flex flex-col gap-2">
          <FormField
            id="confirmPassword"
            name="confirmPassword"
            label={t('auth.fields.passwordConfirmation.label')}
            type={showConfirmPassword ? 'text' : 'password'}
            value={formData.confirmPassword || ''}
            onChange={handleChange}
            required
            minLength={PASSWORD_MIN_LENGTH}
            autoComplete="new-password"
          />
          <Button
            type="button"
            variant="text"
            size="xs"
            className="self-start"
            onClick={() => setShowConfirmPassword((prev) => !prev)}
            aria-label={
              showConfirmPassword ? t('auth.fields.password.hide') : t('auth.fields.password.show')
            }
          >
            {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            <span className="ml-1">
              {showConfirmPassword ? t('auth.fields.password.hide') : t('auth.fields.password.show')}
            </span>
          </Button>
        </div>

        <Button type="submit" variant="solid" size="lg" className="w-full mt-2" disabled={isLoading}>
          {isLoading ? (
            <span className="flex items-center justify-center gap-2">
              <InlineSpinner className="w-4 h-4" />
              {t('auth.signup.submitting')}
            </span>
          ) : (
            t('auth.signup.submit')
          )}
        </Button>
      </form>

      <div className="mt-8 text-center">
        <AuthFormFooter
          questionText={t('auth.signup.footerQuestion')}
          linkText={t('auth.signup.footerLink')}
          href={nextPath ? `/login?next=${encodeURIComponent(nextPath)}` : '/login'}
        />
      </div>
    </>
  );
}
