import type { VideoList as VideoListType } from '@/lib/api';
import { VideoCard } from './VideoCard';
import { useTranslation } from 'react-i18next';
import { MenuList, MenuListItem } from '@/components/ui/menu-list';

interface VideoListProps {
  videos: VideoListType[];
}

export function VideoList({ videos }: VideoListProps) {
  const { t } = useTranslation();

  if (videos.length === 0) {
    return (
      <div className="border-t border-solid-gray-420 py-12 text-solid-gray-700">
        <p className="text-std-17B-170">{t('videos.list.noVideos')}</p>
        <p className="mt-1 text-std-17N-170 text-solid-gray-600">
          {t('videos.list.noVideosHint')}
        </p>
      </div>
    );
  }

  return (
    <MenuList className="border-t border-solid-gray-420">
      {videos.map((video) => (
        <MenuListItem key={video.id} className="border-b border-solid-gray-200">
          <VideoCard video={video} />
        </MenuListItem>
      ))}
    </MenuList>
  );
}
