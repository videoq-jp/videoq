import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ChipLabel } from '@/components/ui/chip-label';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogHeading,
  useDialog,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  DEFAULT_TAG_CHIP_COLOR,
  TAG_CHIP_COLORS,
  type TagChipColor,
} from '@/lib/tagColors';
import { cn } from '@/lib/digital-agency/cn';
import { useTranslation } from 'react-i18next';

interface TagCreateDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string, color: string) => Promise<void>;
}

export function TagCreateDialog({ isOpen, onClose, onCreate }: TagCreateDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [color, setColor] = useState<TagChipColor>(DEFAULT_TAG_CHIP_COLOR);
  const [isCreating, setIsCreating] = useState(false);

  const handleClose = () => {
    if (!isCreating) {
      // Restore native dialog focus before the parent can unmount it.
      dialog.dialogProps.ref.current?.close();
      setName('');
      setColor(DEFAULT_TAG_CHIP_COLOR);
      onClose();
    }
  };

  const dialog = useDialog({
    open: isOpen,
    onOpenChange: (open) => {
      if (!open) handleClose();
    },
    onRequestClose: (event) => {
      if (isCreating) event.preventDefault();
    },
  });

  const handleCreate = async () => {
    if (!name.trim()) return;

    setIsCreating(true);
    try {
      await onCreate(name.trim(), color);
      setName('');
      setColor(DEFAULT_TAG_CHIP_COLOR);
      dialog.dialogProps.ref.current?.close();
      onClose();
    } catch (error) {
      console.error('Failed to create tag:', error);
    } finally {
      setIsCreating(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Dialog {...dialog.dialogProps} width="min(32rem, 92vw)">
      <DialogContent>
        <DialogHeader>
          <DialogHeading {...dialog.headingProps}>
            {t('tags.create.title')}
          </DialogHeading>
        </DialogHeader>

        <DialogBody>
          <p className="mb-4 text-std-16N-170 text-solid-gray-700">
            {t('tags.create.description')}
          </p>

          <div className="space-y-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="tag-name">{t('tags.create.nameLabel')}</Label>
              <Input
                id="tag-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isCreating}
                maxLength={50}
                blockSize="md"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label>{t('tags.create.colorLabel')}</Label>
              <div className="flex flex-wrap gap-2">
                {TAG_CHIP_COLORS.map((paletteColor) => (
                  <button
                    key={paletteColor}
                    type="button"
                    onClick={() => setColor(paletteColor)}
                    disabled={isCreating}
                    className={cn(
                      'rounded-8 transition-opacity disabled:cursor-not-allowed disabled:opacity-50',
                      color === paletteColor
                        ? 'opacity-100 ring-2 ring-key-900 ring-offset-2'
                        : 'opacity-70 hover:opacity-100',
                    )}
                    aria-label={t('tags.create.selectColor', {
                      color: paletteColor,
                      defaultValue: `Select color ${paletteColor}`,
                    })}
                    aria-pressed={color === paletteColor}
                  >
                    <ChipLabel
                      variant="filled-1"
                      color={paletteColor}
                      className="min-h-0 px-2.5 py-1 text-oln-14N-100"
                    >
                      {paletteColor}
                    </ChipLabel>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label>{t('tags.create.preview')}</Label>
              <div className="rounded-8 border border-solid-gray-300 bg-solid-gray-50 p-3">
                <ChipLabel variant="outlined" color={color} className="min-h-0">
                  {name || t('tags.create.previewPlaceholder')}
                </ChipLabel>
              </div>
            </div>
          </div>
        </DialogBody>

        <DialogActions>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={handleClose} disabled={isCreating}>
              {t('common.actions.cancel')}
            </Button>
            <Button type="button" onClick={() => { void handleCreate(); }} disabled={!name.trim() || isCreating}>
              {isCreating ? (
                <span className="flex items-center justify-center">
                  <InlineSpinner className="mr-2" />
                  {t('common.actions.creating', 'Creating...')}
                </span>
              ) : (
                t('common.actions.create')
              )}
            </Button>
          </div>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
