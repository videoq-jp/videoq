import { useTranslation } from 'react-i18next';
import { Link } from '@/lib/i18n';
import { UtilityLink } from '@/components/ui/utility-link';
import { ViewerHeader } from '@/components/video/ViewerHeader';
import { useViewerViewport } from '@/hooks/useViewerViewport';
import { LoadingSpinner } from './LoadingSpinner';

/** Keep an escape route available while showing the standard loading indicator. */
export function DetailLoading({ backHref }: { backHref: string }) {
  const { t } = useTranslation();
  const viewportHeight = useViewerViewport();
  return (
    <div style={{ height: viewportHeight }} className="flex h-dvh flex-col bg-white">
      <ViewerHeader title="" backHref={backHref} />
      <main className="flex-1 p-6">
        <UtilityLink asChild>
          <Link href={backHref}>{t('common.actions.backToList')}</Link>
        </UtilityLink>
        <LoadingSpinner />
      </main>
    </div>
  );
}
