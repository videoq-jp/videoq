import type { ReactNode } from 'react';
import { BrandLogo } from '@/components/layout/BrandLogo';
import { Link } from '@/lib/i18n';

export function ViewerHeader({ title, backHref = '/', children }: {
  title: string;
  backHref?: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex h-[var(--site-header-height)] shrink-0 items-center gap-x-2 border-b border-border bg-white px-4 text-solid-gray-800 sm:gap-x-4 sm:px-6">
      <Link href={backHref} className="site-header-logo text-std-20B-150">
        <BrandLogo />
      </Link>
      <span className="hidden h-6 w-px shrink-0 bg-solid-gray-420 lg:block" aria-hidden="true" />
      <h1 className="min-w-0 flex-1 truncate text-std-17N-170" title={title}>{title}</h1>
      <div className="ml-auto flex min-w-0 max-w-[calc(100%-5.5rem)] items-center gap-2 lg:max-w-none">{children}</div>
    </header>
  );
}
