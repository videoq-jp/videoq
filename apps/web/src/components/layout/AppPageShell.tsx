import type { ReactNode } from 'react';
import { AppFooter } from '@/components/layout/AppFooter';
import { AppNav, type ActivePage } from '@/components/layout/AppNav';
import { APP_CONTAINER_CLASS } from '@/components/layout/layoutTokens';

interface AppPageShellProps {
  activePage?: ActivePage;
  children: ReactNode;
  contentClassName?: string;
  variant?: 'standard' | 'workspace' | 'viewer';
}

export function AppPageShell({
  activePage,
  children,
  contentClassName = APP_CONTAINER_CLASS,
  variant = 'standard',
}: AppPageShellProps) {
  if (variant === 'viewer') return <>{children}</>;

  const mainClassName = variant === 'workspace'
    ? 'flex w-full flex-1 flex-col'
    : `mx-auto w-full flex-1 pb-16 pt-8 ${contentClassName}`;

  return (
    <div
      className={`flex min-h-screen flex-col text-solid-gray-800 ${variant === 'standard' ? 'bg-background' : 'bg-solid-gray-50'}`}
      style={{ scrollbarGutter: 'stable' }}
    >
      <AppNav activePage={activePage} />
      <main className={mainClassName}>
        {children}
      </main>
      {variant === 'standard' && <AppFooter />}
    </div>
  );
}
