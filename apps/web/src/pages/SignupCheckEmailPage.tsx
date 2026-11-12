import { Link } from '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { AuthPageIntro } from '@/components/layout/AuthPageIntro';
import { MessageAlert } from '@/components/common/MessageAlert';
import { UtilityLink } from '@/components/ui/utility-link';

export default function SignupCheckEmailPage() {
  const { t } = useTranslation();

  return (
    <>
      <div className="space-y-6">
        <AuthPageIntro
          badge={t('auth.checkEmail.badge')}
          title={t('auth.checkEmail.title')}
          description={t('auth.checkEmail.description')}
        />

        <MessageAlert type="success" message={t('auth.checkEmail.alert')} />

        <p className="text-center text-std-17N-170 text-solid-gray-600">
          {t('auth.checkEmail.help')}
        </p>

        <div className="text-center">
          <UtilityLink asChild>
            <Link href="/login">{t('auth.checkEmail.backToLogin')}</Link>
          </UtilityLink>
        </div>
      </div>

    </>
  );
}
