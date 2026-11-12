import { BrandLogo } from '@/components/layout/BrandLogo';
import type { ReactNode } from 'react';
import { Link } from '@/lib/i18n';
import { AuthPageFooter } from '@/components/layout/AuthPageFooter';
import { APP_CONTAINER_CLASS, APP_HEADER_CONTAINER_CLASS } from '@/components/layout/layoutTokens';

interface AuthLayoutProps {
  children: ReactNode;
}

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="site-header">
        <div className={`mx-auto w-full ${APP_HEADER_CONTAINER_CLASS}`}>
          <div className="site-header-content">
            <Link
              href="/"
              className="site-header-logo text-std-20B-150"
            >
              <BrandLogo />
            </Link>
          </div>
        </div>
      </header>

      <main className={`mx-auto w-full flex-1 py-12 lg:pt-20 lg:pb-36 ${APP_CONTAINER_CLASS}`}>
        <div className="mx-auto w-full max-w-[32rem]">
          {children}
        </div>
      </main>

      <div className={`mx-auto w-full pb-10 ${APP_CONTAINER_CLASS}`}>
        <AuthPageFooter />
      </div>
    </div>
  );
}
