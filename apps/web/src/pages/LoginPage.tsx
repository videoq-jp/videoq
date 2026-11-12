import { features } from "@/lib/deployment";
import { authClient } from '@/lib/auth-client';
import { useEffect, useState } from 'react';
import { useAuthSession } from '@/lib/authSession';
import { useSearchParams } from 'react-router-dom';
import { Link, useI18nNavigate } from '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { useAuthForm } from '@/hooks/useAuthForm';
import { apiClient } from '@/lib/api';
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
import { oauthAuthorizeResumeUrl } from '@/lib/oauthResume';
import { getSafeNextPath } from '@/lib/authRedirect';

export default function LoginPage() {
  const navigate = useI18nNavigate();
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const nextPath = getSafeNextPath(searchParams.get('next'));
  const oauthResume = oauthAuthorizeResumeUrl(searchParams);
  const afterLogin = oauthResume || nextPath;
  const oauthError = searchParams.get('error');
  const oauthErrorMessage = oauthError === 'email_not_verified'
    ? t('auth.login.oauthEmailVerificationRequired')
    : oauthError === 'account_not_linked'
      ? t('auth.login.oauthAccountNotLinked')
      : t('auth.login.oauthCallbackFailed');
  const [showPassword, setShowPassword] = useState(false);
  const session = useAuthSession();
  const sessionUserId = session.data?.user?.id;

  // AuthProvider replaces the query cache on identity changes and may unmount
  // the login mutation before its success redirect runs. The authoritative
  // session owns the on-prem redirect so late callbacks cannot restart it.
  useEffect(() => {
    if (features.publicSignup || session.isPending || !sessionUserId) return;
    if (afterLogin) window.location.href = afterLogin;
    else navigate('/');
  }, [afterLogin, navigate, sessionUserId, session.isPending]);

  const { formData, error, isLoading, handleChange, handleSubmit } = useAuthForm({
    onSubmit: async (data) => {
      await apiClient.login(data);
      // Refresh the session atom. AuthProvider clears the previous account's
      // cache before the destination page loads its own profile and data.
      await authClient.getSession();
    },
    initialData: { username: '', password: '' },
    onSuccessRedirect: features.publicSignup ? () => {
      if (afterLogin) {
        // OAuth authorize pages are served by the API, outside the SPA router.
        window.location.href = afterLogin;
        return;
      }
      navigate('/');
    } : undefined,
  });

  return (
    <>
      <AuthPageIntro badge={t('auth.login.badge')} title={t('auth.login.title')} />

      {(error || oauthError) && (
        <div className="mb-4">
          <ErrorMessage message={error || oauthErrorMessage} />
        </div>
      )}

      {features.googleLogin && <>
      <GoogleSignInButton callbackURL={afterLogin || '/'} />

      <div className="my-8 flex items-center gap-4">
        <Divider className="flex-1" aria-hidden="true" />
        <span className="shrink-0 text-dns-14N-130 text-solid-gray-600">
          {t('auth.login.orDivider')}
        </span>
        <Divider className="flex-1" aria-hidden="true" />
      </div>

      </>}
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

        <div className="flex flex-col gap-2">
          <FormField
            id="password"
            name="password"
            label={t('auth.fields.password.label')}
            type={showPassword ? 'text' : 'password'}
            value={formData.password || ''}
            onChange={handleChange}
            required
            autoComplete="current-password"
            showRequirementBadge
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

        {features.emailDelivery && <div className="flex justify-end py-1">
          <UtilityLink asChild>
            <Link href="/forgot-password">{t('auth.login.forgotPassword')}</Link>
          </UtilityLink>
        </div>}

        <Button type="submit" variant="solid" size="lg" className="w-full" disabled={isLoading}>
          {isLoading ? (
            <span className="flex items-center justify-center gap-2">
              <InlineSpinner className="w-4 h-4" />
              {t('auth.login.submitting')}
            </span>
          ) : (
            t('auth.login.submit')
          )}
        </Button>
      </form>

      {features.publicSignup && <div className="mt-8 text-center">
        <AuthFormFooter
          questionText={t('auth.login.footerQuestion')}
          linkText={t('auth.login.footerLink')}
          href={nextPath ? `/signup?next=${encodeURIComponent(nextPath)}` : '/signup'}
        />
      </div>}
      {!features.publicSignup && <p className="mt-6 text-std-17N-170">{t("onprem.loginHelp")}</p>}
    </>
  );
}
