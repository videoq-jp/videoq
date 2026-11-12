import type { ReactNode } from 'react';
import { BrandLogo } from '@/components/layout/BrandLogo';
import { Link } from '@/lib/i18n';

export function ViewerHeader({ title, backHref = '/', children }: {
  title: string;
  backHref?: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-white px-4 py-2 text-solid-gray-800 lg:flex-nowrap lg:px-6">
      <Link href={backHref} className="shrink-0 text-std-20B-150 focus-visible:bg-yellow-300 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-black">
        <BrandLogo />
      </Link>
      <span className="hidden h-6 w-px shrink-0 bg-solid-gray-420 lg:block" aria-hidden="true" />
      <h1 className="order-last min-w-0 basis-full truncate text-std-16N-170 lg:order-none lg:flex-1 lg:basis-0" title={title}>{title}</h1>
      <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>
    </header>
  );
}
