import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import { ErrorMessage } from '@/components/auth/ErrorMessage';
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogHeading,
  useDialog,
} from '@/components/ui/dialog';
import { useTags } from '@/hooks/useTags';
import { TagBadge } from '@/components/video/TagBadge';

interface TagManagementModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function TagManagementModal({ isOpen, onClose }: TagManagementModalProps) {
  const { t } = useTranslation();
  // Not `error`: handleDelete's catch clause would shadow it.
  const { tags, deleteTag, deletingTagId, error: tagsError } = useTags({ enabled: isOpen });
  const isDeleting = deletingTagId !== null;
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const deleteButtons = useRef(new Map<number, HTMLButtonElement>());
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const previousConfirmId = useRef<number | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  const dialog = useDialog({
    open: isOpen,
    onOpenChange: (open) => {
      if (!open) {
        dialog.dialogProps.ref.current?.close();
        setDeleteConfirmId(null);
        onClose();
      }
    },
    onRequestClose: (event) => {
      if (isDeleting) event.preventDefault();
    },
  });

  useEffect(() => {
    if (deleteConfirmId !== null) cancelDeleteRef.current?.focus();
    else if (previousConfirmId.current !== null) {
      const target = deleteButtons.current.get(previousConfirmId.current) ?? dialog.headingProps.ref.current;
      target?.focus();
    }
    previousConfirmId.current = deleteConfirmId;
  }, [deleteConfirmId, dialog.headingProps.ref]);

  useEffect(() => {
    if (tagsError && !isDeleting) errorRef.current?.focus();
  }, [tagsError, isDeleting]);

  const handleDelete = async (id: number) => {
    try {
      await deleteTag(id);
      setDeleteConfirmId(null);
    } catch (error) {
      console.error('Failed to delete tag:', error);
    }
  };

  if (!isOpen) return null;

  return (
    <Dialog {...dialog.dialogProps} width="min(28rem, 92vw)">
      <DialogContent>
        <DialogHeader>
          <DialogHeading {...dialog.headingProps}>
            {t('tags.management.title', 'Tag Management')}
          </DialogHeading>
        </DialogHeader>

        <DialogBody>
          <p className="mb-4 text-std-16N-170 text-solid-gray-700">
            {t('tags.management.description', 'Review existing tags and remove tags you no longer need.')}
          </p>

          {/* Outside the scrolling list on purpose: a failure on a tag further
              down would otherwise be reported off screen. */}
          {tagsError ? (
            <div ref={errorRef} tabIndex={-1} className="mb-4 focus-visible:outline-4 focus-visible:outline-black focus-visible:outline-offset-2">
              <ErrorMessage message={tagsError} />
            </div>
          ) : null}

          <div className="max-h-[60vh] space-y-4 overflow-y-auto py-2">
            {tags.length === 0 ? (
              <div className="py-8 text-center text-sm text-solid-gray-600">
                {t('tags.selector.noTags', 'No tags available')}
              </div>
            ) : (
              <div className="space-y-2">
                {tags.map((tag) => (
                  <div
                    key={tag.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-8 border border-solid-gray-200 bg-solid-gray-50 p-3"
                  >
                    <div className="flex min-w-0 flex-1 basis-40 items-center gap-2">
                      <TagBadge tag={tag} size="sm" />
                    </div>

                    {deleteConfirmId === tag.id ? (
                      <div className="ml-auto flex shrink-0 items-center gap-2">
                        <Button
                          variant="solid"
                          size="sm"
                          className="whitespace-nowrap bg-error-1 hover:bg-red-1000 active:bg-red-1200"
                          onClick={() => { void handleDelete(tag.id); }}
                          disabled={isDeleting}
                          aria-busy={deletingTagId === tag.id}
                          data-testid={`confirm-delete-${tag.id}`}
                        >
                          {deletingTagId === tag.id ? <InlineSpinner className="h-4 w-4" /> : null}
                          {t('common.actions.delete', 'Delete')}
                        </Button>
                        <Button
                          ref={cancelDeleteRef}
                          variant="text"
                          size="sm"
                          className="whitespace-nowrap"
                          onClick={() => setDeleteConfirmId(null)}
                          disabled={isDeleting}
                          data-testid={`cancel-delete-${tag.id}`}
                        >
                          {t('common.actions.cancel', 'Cancel')}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        ref={(node) => {
                          if (node) deleteButtons.current.set(tag.id, node);
                          else deleteButtons.current.delete(tag.id);
                        }}
                        variant="text"
                        size="sm"
                        className="min-w-9 px-2 text-solid-gray-600 hover:text-error-1"
                        onClick={() => setDeleteConfirmId(tag.id)}
                        disabled={isDeleting}
                        data-testid={`delete-tag-${tag.id}`}
                        aria-label={`${t('common.actions.delete', 'Delete')}: ${tag.name}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogBody>

        <DialogActions>
          <div className="flex justify-end gap-3">
            <Button variant="outline" {...dialog.closeButtonProps} disabled={isDeleting}>
              {t('common.actions.close', 'Close')}
            </Button>
          </div>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
