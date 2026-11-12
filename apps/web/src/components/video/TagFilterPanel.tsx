import { useTranslation } from 'react-i18next';
import type { Tag } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { ChipLabel } from '@/components/ui/chip-label';
import { resolveTagChipColor } from '@/lib/tagColors';
import { cn } from '@/lib/digital-agency/cn';
import { Settings2 } from 'lucide-react';

interface TagFilterPanelProps {
  tags: Tag[];
  selectedTagIds: number[];
  onToggle: (tagId: number) => void;
  onClear: () => void;
  onManageTags?: () => void;
  disabled?: boolean;
}

export function TagFilterPanel({
  tags,
  selectedTagIds,
  onToggle,
  onClear,
  onManageTags,
  disabled = false,
}: TagFilterPanelProps) {
  const { t } = useTranslation();

  if (tags.length === 0) {
    return null;
  }

  return (
    <div className="rounded-8 border border-solid-gray-300 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-std-17B-170 text-solid-gray-800">{t('tags.filter.title')}</h3>
          {onManageTags && (
            <Button
              type="button"
              variant="text"
              size="xs"
              onClick={onManageTags}
              disabled={disabled}
              className="min-w-6 px-1 text-solid-gray-420 hover:text-solid-gray-800"
              title={t('tags.management.title')}
              aria-label={t('tags.management.title')}
            >
              <Settings2 className="h-4 w-4" />
            </Button>
          )}
        </div>
        {selectedTagIds.length > 0 && (
          <Button
            type="button"
            variant="text"
            size="sm"
            onClick={onClear}
            disabled={disabled}
            className="h-7 min-w-0 px-2 text-dns-14N-130"
          >
            {t('tags.filter.clear')}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {tags.map((tag) => {
          const isSelected = selectedTagIds.includes(tag.id);
          return (
            <button
              key={tag.id}
              type="button"
              onClick={() => onToggle(tag.id)}
              disabled={disabled}
              className={cn(
                'rounded-8 transition-opacity focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-black focus-visible:ring-2 focus-visible:ring-yellow-300 disabled:cursor-not-allowed',
                isSelected ? 'opacity-100' : 'opacity-60 hover:opacity-80',
              )}
              aria-pressed={isSelected}
            >
              <ChipLabel
                variant={isSelected ? 'filled-1' : 'outlined'}
                color={resolveTagChipColor(tag.color)}
                className="min-h-0 text-oln-14N-100"
              >
                {tag.name}
                {tag.video_count !== undefined && (
                  <span className="ml-1.5 opacity-75">({tag.video_count})</span>
                )}
              </ChipLabel>
            </button>
          );
        })}
      </div>

      {selectedTagIds.length > 0 && (
        <div className="mt-3 border-t border-solid-gray-200 pt-3">
          <p className="text-dns-14N-130 text-solid-gray-600">
            {t('tags.filter.selected', { count: selectedTagIds.length })}
          </p>
        </div>
      )}
    </div>
  );
}
