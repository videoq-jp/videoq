import type { ReactNode } from 'react';

interface AuthPageIntroProps {
  badge: ReactNode;
  title: ReactNode;
  description?: ReactNode;
}

export function AuthPageIntro({ badge, title, description }: AuthPageIntroProps) {
  return (
    <div className="mb-12">
      <p className="mb-4 text-std-17B-170 text-solid-gray-600">{badge}</p>
      <h1 className="site-page-title mb-6 break-words text-std-28B-150 md:text-std-45B-140">{title}</h1>
      {description ? (
        <p className="text-std-17N-170 text-solid-gray-700">{description}</p>
      ) : null}
    </div>
  );
}
