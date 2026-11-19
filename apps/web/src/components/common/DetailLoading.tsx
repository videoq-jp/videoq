import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Search } from 'lucide-react';
import { ViewerHeader } from '@/components/video/ViewerHeader';
import { useViewerViewport } from '@/hooks/useViewerViewport';
import { Heading, HeadingTitle } from '@/components/ui/heading';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InlineLoading } from './InlineLoading';

/** Reserve the real player and transcript columns while video metadata loads. */
export function DetailLoading({ backHref, mobileTabs, isMobile = false, mobileTab = 'video' }: {
  backHref: string; mobileTabs?: ReactNode; isMobile?: boolean; mobileTab?: 'video' | 'transcript';
}) {
  const { t } = useTranslation();
  const viewportHeight = useViewerViewport();
  return <div data-video-viewer style={{ height: viewportHeight }} className="flex h-dvh flex-col overflow-hidden bg-white">
    <ViewerHeader title={t('videos.detail.video')} backHref={backHref} />
    {mobileTabs}
    <main className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(22rem,3fr)]">
      <div className={`min-h-0 min-w-0 overflow-y-auto ${isMobile && mobileTab !== 'video' ? 'hidden' : ''}`}>
        <div data-player-loading className="flex aspect-video w-full items-center justify-center bg-solid-gray-50"><InlineLoading /></div>
      </div>
      <div className={`min-h-0 min-w-0 flex-1 ${isMobile && mobileTab !== 'transcript' ? 'hidden' : ''}`}>
        <div className="flex h-full min-h-0 flex-col border-t border-solid-gray-420 lg:border-l lg:border-t-0">
          <div className="flex shrink-0 flex-col gap-3 border-b border-solid-gray-200 p-4">
            <div className="flex items-center justify-between">
              <Heading size="18"><HeadingTitle level="h2">{t('videos.detail.transcriptSection')}</HeadingTitle></Heading>
              <Button variant="outline" size="xs" disabled><Pencil className="mr-1.5 h-3.5 w-3.5" />{t('videos.detail.editTranscriptButton')}</Button>
            </div>
            <div className="relative w-full">
              <Search className="absolute left-3 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-solid-gray-600" />
              <Input type="search" blockSize="sm" disabled aria-label={t('videos.detail.transcriptSearchPlaceholder')} className="block w-full pl-9" />
            </div>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center p-4"><InlineLoading /></div>
        </div>
      </div>
    </main>
  </div>;
}
