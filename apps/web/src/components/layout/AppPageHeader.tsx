import type { ReactNode } from 'react';

interface AppPageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  badge?: ReactNode;
  className?: string;
}

export function AppPageHeader({
  title,
  description,
  action,
  badge,
  className = '',
}: AppPageHeaderProps) {
  return (
    <header className={`mb-12 md:mb-16 flex flex-col justify-between gap-6 lg:flex-row lg:items-end ${className}`}>
      <div className="min-w-0">
        <div className="mb-6">
          {badge ? <p className="mb-4 text-std-17B-170 text-solid-gray-600">{badge}</p> : null}
          <h1 className="break-words text-std-28B-150 md:text-std-45B-140">{title}</h1>
        </div>
        {description ? (
          <p className="max-w-4xl text-std-17N-170 text-solid-gray-700">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}
