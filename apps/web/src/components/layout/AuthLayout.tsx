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
      <header className="border-b border-border bg-white">
        <div className={`mx-auto flex w-full items-center min-h-[4.5rem] py-3 md:min-h-20 ${APP_HEADER_CONTAINER_CLASS}`}>
          <Link
            href="/"
            className="text-std-20B-150 text-solid-gray-800"
          >
            <BrandLogo />
          </Link>
        </div>
      </header>

      <main className={`mx-auto w-full flex-1 py-12 md:pt-20 md:pb-36 ${APP_CONTAINER_CLASS}`}>
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
