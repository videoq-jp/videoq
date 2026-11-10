import { BrandLogo } from '@/components/layout/BrandLogo';
import { features } from "@/lib/deployment";
import { useTranslation } from 'react-i18next';
import { Link } from '@/lib/i18n';
import { APP_CONTAINER_CLASS } from '@/components/layout/layoutTokens';
import { UtilityLink } from '@/components/ui/utility-link';
import { Divider } from '@/components/ui/divider';

export function AppFooter() {
  const { t } = useTranslation();

  return (
    <footer className="mt-auto w-full border-t border-border bg-white">
      <div className={`mx-auto w-full py-10 ${APP_CONTAINER_CLASS}`}>
        <div className="mb-6">
          <p className="text-std-18B-160 text-solid-gray-800"><BrandLogo /></p>
          <p className="mt-2 text-std-16N-170 text-solid-gray-700">
            {t('layout.authBranding.tagline')}
          </p>
        </div>
        <Divider className="mb-6" />
        <nav className="mb-6 flex flex-wrap gap-x-6 gap-y-2">
          <UtilityLink asChild>
            <Link href="/">{t('navigation.home')}</Link>
          </UtilityLink>
          {features.marketing && <>
          <UtilityLink asChild>
            <Link href="/pricing">{t('navigation.pricing')}</Link>
          </UtilityLink>
          <UtilityLink asChild>
            <Link href="/guides">{t('navigation.guides')}</Link>
          </UtilityLink>
          <UtilityLink asChild>
            <Link href="/terms">{t('legal.terms.title')}</Link>
          </UtilityLink>
          <UtilityLink asChild>
            <Link href="/privacy">{t('legal.privacy.title')}</Link>
          </UtilityLink>
          <UtilityLink asChild>
            <Link href="/refund">{t('legal.refund.title')}</Link>
          </UtilityLink>
          <UtilityLink asChild>
            <Link href="/legal">{t('legal.scta.shortTitle')}</Link>
          </UtilityLink>
          </>}
          <UtilityLink asChild>
            <Link href="/login">{t('auth.login.submit')}</Link>
          </UtilityLink>
          {features.publicSignup && <UtilityLink asChild>
            <Link href="/signup">{t('auth.signup.submit')}</Link>
          </UtilityLink>}
        </nav>
        {/* The prerendered year can predate the visit. */}
        <p className="text-oln-14N-100 text-solid-gray-600" suppressHydrationWarning>
          © {new Date().getFullYear()} VideoQ
        </p>
      </div>
    </footer>
  );
}
