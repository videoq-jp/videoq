import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import type { Dispatch, SetStateAction } from 'react';
import type { Tag } from '@/lib/api';
import { Save, X } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ErrorMessage } from '@/components/auth/ErrorMessage';
import { TagSelector } from '@/components/video/TagSelector';
import { Dialog, DialogActions, DialogBody, DialogContent, DialogHeader, DialogHeading, useDialog } from '@/components/ui/dialog';

export function VideoDetailEditDialog({
  isOpen,
  tags,
  editedTitle,
  editedDescription,
  editedTagIds,
  isUpdating,
  updateError,
  onOpenChange,
  onEditedTitleChange,
  onEditedDescriptionChange,
  onEditedTagIdsChange,
  onCreateNewTag,
  onSave,
}: {
  isOpen: boolean;
  tags: Tag[];
  editedTitle: string;
  editedDescription: string;
  editedTagIds: number[];
  isUpdating: boolean;
  updateError: string | null;
  onOpenChange: (open: boolean) => void;
  onEditedTitleChange: (title: string) => void;
  onEditedDescriptionChange: (description: string) => void;
  onEditedTagIdsChange: Dispatch<SetStateAction<number[]>>;
  onCreateNewTag: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();

  const dialog = useDialog({
    open: isOpen,
    onOpenChange,
    onRequestClose: (event) => {
      if (isUpdating) event.preventDefault();
    },
  });

  return (
    <Dialog {...dialog.dialogProps} width="min(32rem, 92vw)">
      {isOpen && <DialogContent>
        <DialogHeader>
          <DialogHeading {...dialog.headingProps}>{t('videos.detail.editButton')}</DialogHeading>
        </DialogHeader>
        <DialogBody>
          <p className="mb-4 text-std-17N-170 text-solid-gray-700">
            {t('videos.detail.editDescriptionLabel')}
          </p>
          <div className="space-y-4">
            {updateError && <ErrorMessage message={updateError} />}
            <div className="flex flex-col gap-2">
              <Label htmlFor="video-edit-title">{t('videos.detail.editTitleLabel')}</Label>
              <Input
                className="block w-full"
                id="video-edit-title"
                type="text"
                value={editedTitle}
                onChange={(event) => onEditedTitleChange(event.target.value)}
                disabled={isUpdating}
                blockSize="md"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="video-edit-description">{t('videos.detail.editDescriptionLabel')}</Label>
              <Textarea
                id="video-edit-description"
                value={editedDescription}
                onChange={(event) => onEditedDescriptionChange(event.target.value)}
                disabled={isUpdating}
                rows={4}
                className="resize-none"
              />
            </div>
            <div className="flex flex-col gap-2">
              <TagSelector
                tags={tags}
                selectedTagIds={editedTagIds}
                onToggle={(tagId) =>
                  onEditedTagIdsChange((prev) =>
                    prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId],
                  )
                }
                onCreateNew={onCreateNewTag}
                disabled={isUpdating}
              />
            </div>
          </div>
        </DialogBody>
        <DialogActions>
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isUpdating}
            >
              <X className="w-3.5 h-3.5" />
              {t('common.actions.cancel')}
            </Button>
            <Button
              type="button"
              onClick={onSave}
              disabled={isUpdating || !editedTitle.trim()}
            >
              {isUpdating ? <InlineSpinner className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
              {isUpdating ? t('common.actions.saving') : t('common.actions.save')}
            </Button>
          </div>
        </DialogActions>
      </DialogContent>}
    </Dialog>
  );
}
