import { BrandLogo } from '@/components/layout/BrandLogo';
import { features } from "@/lib/deployment";
import { useTranslation } from 'react-i18next';
import { Link } from '@/lib/i18n';
import { APP_CONTAINER_CLASS } from '@/components/layout/layoutTokens';
import { UtilityLink } from '@/components/ui/utility-link';

export function AppFooter() {
  const { t } = useTranslation();

  return (
    <footer className="site-footer mt-auto w-full">
      <div className={`mx-auto w-full pt-12 ${APP_CONTAINER_CLASS}`}>
        <div className="site-footer-content">
          <div className="site-footer-brand">
            <p className="text-std-18B-160 text-solid-gray-800"><BrandLogo /></p>
            <p className="mt-2 text-std-17N-170 text-solid-gray-700">
              {t('layout.authBranding.tagline')}
            </p>
          </div>
          <nav>
            <ul className="site-footer-nav">
            <li><UtilityLink asChild>
              <Link href="/">{t('navigation.home')}</Link>
            </UtilityLink></li>
            {features.marketing && <>
            <li><UtilityLink asChild>
              <Link href="/pricing">{t('navigation.pricing')}</Link>
            </UtilityLink></li>
            <li><UtilityLink asChild>
              <Link href="/guides">{t('navigation.guides')}</Link>
            </UtilityLink></li>
            <li><UtilityLink asChild>
              <Link href="/terms">{t('legal.terms.title')}</Link>
            </UtilityLink></li>
            <li><UtilityLink asChild>
              <Link href="/privacy">{t('legal.privacy.title')}</Link>
            </UtilityLink></li>
            <li><UtilityLink asChild>
              <Link href="/refund">{t('legal.refund.title')}</Link>
            </UtilityLink></li>
            <li><UtilityLink asChild>
              <Link href="/legal">{t('legal.scta.shortTitle')}</Link>
            </UtilityLink></li>
            </>}
            <li><UtilityLink asChild>
              <Link href="/login">{t('auth.login.submit')}</Link>
            </UtilityLink></li>
            {features.publicSignup && <li><UtilityLink asChild>
              <Link href="/signup">{t('auth.signup.submit')}</Link>
            </UtilityLink></li>}
            </ul>
          </nav>
          {/* The prerendered year can predate the visit. */}
          <p className="site-footer-copyright" suppressHydrationWarning>
            © {new Date().getFullYear()} VideoQ
          </p>
        </div>
      </div>
    </footer>
  );
}
