import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ChipLabel } from '@/components/ui/chip-label';
import { resolveTagChipColor } from '@/lib/tagColors';
import { cn } from '@/lib/digital-agency/cn';

interface TagBadgeProps {
  tag: { id: number; name: string; color: string };
  onRemove?: (tagId: number) => void;
  size?: 'sm' | 'md';
  className?: string;
}

export function TagBadge({ tag, onRemove, size = 'md', className = '' }: TagBadgeProps) {
  const { t } = useTranslation();
  return (
    <ChipLabel
      variant="outlined"
      color={resolveTagChipColor(tag.color)}
      className={cn(
        'min-h-0',
        size === 'sm' ? 'px-2 py-0.5 text-oln-14N-100' : 'px-2.5 py-1 text-std-17N-170',
        className,
      )}
    >
      {tag.name}
      {onRemove ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(tag.id);
          }}
          className="ml-1 transition-opacity hover:opacity-70"
          aria-label={t('tags.removeLabel', { name: tag.name })}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </ChipLabel>
  );
}
