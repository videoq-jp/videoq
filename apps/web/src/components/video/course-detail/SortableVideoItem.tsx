import { useTranslation } from 'react-i18next';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Trash2 } from 'lucide-react';
import type { VideoInCourse } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import { StatusBadge } from '@/components/common/StatusBadge';
import { getVideoDisplayStatus } from '@/lib/utils/video';

interface SortableVideoItemProps {
  video: VideoInCourse;
  isSelected: boolean;
  onSelect: (videoId: number) => void;
  onRemove: (videoId: number) => void;
  /** True while this video's own removal is in flight. */
  isRemoving: boolean;
  /** True while the course's video membership or order is being saved. */
  isMutationPending: boolean;
  isMobile?: boolean;
  canManage: boolean;
}

export function SortableVideoItem({
  video,
  isSelected,
  onSelect,
  onRemove,
  isRemoving,
  isMutationPending,
  isMobile = false,
  canManage,
}: SortableVideoItemProps) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: video.id,
    disabled: isMobile || !canManage || isMutationPending,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={() => onSelect(video.id)}
      className={`group flex cursor-pointer items-center gap-3 rounded-8 px-4 py-3.5 transition-colors ${
        isSelected
          ? 'border-l-4 border-key-900 bg-blue-50'
          : 'hover:bg-solid-gray-50'
      } ${isDragging ? 'z-50 border border-solid-gray-420 bg-white' : ''}`}
    >
      {!isMobile && canManage && (
        <button
          type="button"
          aria-label={`${t('videos.courses.dragHandle')}: ${video.title}`}
          disabled={isMutationPending}
          {...attributes}
          {...listeners}
          onClick={(event) => event.stopPropagation()}
          className="text-solid-gray-420 cursor-grab active:cursor-grabbing shrink-0 focus-visible:outline-4 focus-visible:outline-black"
        >
          <GripVertical className="w-4 h-4" />
        </button>
      )}
      <button type="button" aria-pressed={isSelected} title={video.title} className="flex-1 min-w-0 text-left rounded-8 focus-visible:outline-4 focus-visible:outline-black">
        <span className={`block truncate text-std-17N-170 ${isSelected ? 'font-bold text-key-900' : 'text-solid-gray-800'}`}>
          {video.title}
        </span>
        <StatusBadge status={getVideoDisplayStatus(video)} size="xs" className="mt-1 ml-0" />
      </button>
      {canManage ? (
        // The wrapper keeps swallowing row-level events even while the button
        // is disabled: a disabled Button gets `pointer-events: none`, so
        // without it a click on the spinner would fall through and select the
        // row underneath.
        <span
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          className="shrink-0"
        >
          <Button
            type="button"
            variant="text"
            size="xs"
            onClick={() => onRemove(video.id)}
            disabled={isMutationPending}
            aria-busy={isRemoving}
            aria-label={t('videos.courseDetail.removeFromCourse')}
            className="min-w-0 shrink-0 p-1.5 text-error-1 hover:bg-red-50"
          >
            {isRemoving ? <InlineSpinner className="h-3.5 w-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
          </Button>
        </span>
      ) : null}
    </div>
  );
}
