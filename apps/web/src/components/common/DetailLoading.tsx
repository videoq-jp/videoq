import { useTranslation } from 'react-i18next';
import { Link } from '@/lib/i18n';
import { UtilityLink } from '@/components/ui/utility-link';
import { LoadingSpinner } from './LoadingSpinner';

/** Preserve the viewer's shape and an escape route while its data loads. */
export function DetailLoading({ backHref }: { backHref: string }) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto w-full max-w-7xl p-6">
      <UtilityLink asChild>
        <Link href={backHref}>{t('common.actions.backToList')}</Link>
      </UtilityLink>
      <div aria-hidden="true" className="mt-6 motion-safe:animate-pulse">
        <div className="mb-6 h-8 w-2/3 rounded bg-solid-gray-100" />
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="aspect-video rounded bg-solid-gray-100 lg:col-span-2" />
          <div className="min-h-48 rounded bg-solid-gray-100" />
        </div>
      </div>
      <LoadingSpinner />
    </div>
  );
}
