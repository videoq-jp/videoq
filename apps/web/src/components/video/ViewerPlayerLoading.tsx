import { useTranslation } from 'react-i18next';
import { InlineLoading } from '@/components/common/InlineLoading';
import { ViewerPlayerFrame } from './ViewerPlayerFrame';

/** Same playback geometry before metadata and media are available. */
export function ViewerPlayerLoading({ expanded = true, onExpandedChange = () => {} }: {
  expanded?: boolean; onExpandedChange?: (expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  return <ViewerPlayerFrame title={t('videos.shared.playerPlaceholder')} expanded={expanded} onExpandedChange={onExpandedChange}>
    <div data-player-loading className="flex aspect-video max-h-[clamp(4rem,calc(100dvh-27rem),28dvh)] w-full items-center justify-center bg-solid-gray-50 lg:max-h-[72dvh]">
      <InlineLoading />
    </div>
  </ViewerPlayerFrame>;
}
