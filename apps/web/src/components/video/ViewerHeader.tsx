import type { ReactNode } from 'react';
import { BrandLogo } from '@/components/layout/BrandLogo';
import { Link } from '@/lib/i18n';

export function ViewerHeader({ title, backHref = '/', children }: {
  title: string;
  backHref?: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex min-h-[var(--site-header-height)] shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-white px-4 py-1 text-solid-gray-800 sm:gap-x-4 sm:px-6 sm:py-3 lg:flex-nowrap lg:py-0">
      <Link href={backHref} className="site-header-logo text-std-20B-150">
        <BrandLogo />
      </Link>
      <span className="hidden h-6 w-px shrink-0 bg-solid-gray-420 lg:block" aria-hidden="true" />
      <h1 className="order-last min-w-0 basis-full truncate text-std-17N-170 lg:order-none lg:flex-1 lg:basis-0" title={title}>{title}</h1>
      <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>
    </header>
  );
}
