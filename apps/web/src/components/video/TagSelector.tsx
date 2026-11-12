import { useTranslation } from 'react-i18next';
import type { Tag } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { ChipLabel } from '@/components/ui/chip-label';
import { Label } from '@/components/ui/label';
import { resolveTagChipColor } from '@/lib/tagColors';
import { cn } from '@/lib/digital-agency/cn';

interface TagSelectorProps {
  tags: Tag[];
  selectedTagIds: number[];
  onToggle: (tagId: number) => void;
  onCreateNew?: () => void;
  disabled?: boolean;
}

export function TagSelector({
  tags,
  selectedTagIds,
  onToggle,
  onCreateNew,
  disabled = false,
}: TagSelectorProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <Label size="sm" className="text-solid-gray-700">
          {t('tags.selector.label')}
        </Label>
        {onCreateNew && (
          <Button
            type="button"
            variant="text"
            size="xs"
            onClick={onCreateNew}
            disabled={disabled}
            className="min-w-0 px-1"
          >
            + {t('tags.selector.createNew')}
          </Button>
        )}
      </div>
      <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto rounded-8 border border-solid-gray-300 bg-solid-gray-50 p-2">
        {tags.length === 0 ? (
          <p className="text-std-17N-170 text-solid-gray-600">{t('tags.selector.noTags')}</p>
        ) : (
          tags.map((tag) => {
            const isSelected = selectedTagIds.includes(tag.id);
            return (
              <button
                key={tag.id}
                type="button"
                onClick={() => !disabled && onToggle(tag.id)}
                disabled={disabled}
                className={cn(
                  'rounded-8 transition-opacity focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-black focus-visible:ring-2 focus-visible:ring-yellow-300',
                  isSelected ? 'opacity-100' : 'opacity-60 hover:opacity-100',
                  disabled ? 'cursor-not-allowed' : 'cursor-pointer',
                )}
                aria-pressed={isSelected}
              >
                <ChipLabel
                  variant={isSelected ? 'filled-1' : 'outlined'}
                  color={resolveTagChipColor(tag.color)}
                  className="min-h-0 text-oln-14N-100"
                >
                  {tag.name}
                </ChipLabel>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
