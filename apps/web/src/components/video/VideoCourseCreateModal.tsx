import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
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
import { useTranslation } from 'react-i18next';

interface VideoCourseCreateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string, description: string) => Promise<void>;
}

export function VideoCourseCreateModal({ isOpen, onClose, onCreate }: VideoCourseCreateModalProps) {
  const { t } = useTranslation();
  const nameId = useId();
  const descriptionId = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const handleClose = () => {
    if (!isCreating) {
      // Restore native dialog focus before the parent can unmount it.
      dialog.dialogProps.ref.current?.close();
      setName('');
      setDescription('');
      setFormError(null);
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
    if (!name.trim()) {
      setFormError(t('validation.required'));
      return;
    }
    setFormError(null);
    setIsCreating(true);
    try {
      await onCreate(name.trim(), description.trim());
      handleClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('videos.courses.createError');
      setFormError(msg);
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
            {t('videos.courses.createTitle')}
          </DialogHeading>
        </DialogHeader>

        <DialogBody>
          <p className="mb-4 text-std-16N-170 text-solid-gray-700">
            {t('videos.courses.subtitle')}
          </p>

          <div className="space-y-4">
            {formError && (
              <div role="alert" className="rounded-8 border border-error-1 bg-red-50 p-3 text-sm text-error-1">
                {formError}
              </div>
            )}

            <div className="space-y-1.5">
              <label htmlFor={nameId} className="text-xs font-bold uppercase tracking-wider text-solid-gray-700">
                {t('videos.courses.nameLabel')}
              </label>
              <input
                id={nameId}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('videos.courses.namePlaceholder')}
                disabled={isCreating}
                autoFocus
                className="w-full rounded-8 border border-solid-gray-600 bg-white px-4 py-3 text-sm text-solid-gray-800 placeholder:text-solid-gray-600 focus:outline focus:outline-4 focus:outline-black focus:outline-offset-[calc(2/16*1rem)] focus:ring-[calc(2/16*1rem)] focus:ring-yellow-300 disabled:border-solid-gray-300 disabled:bg-solid-gray-50 disabled:text-solid-gray-420 disabled:placeholder:text-solid-gray-420 disabled:forced-colors:border-[GrayText] disabled:forced-colors:text-[GrayText]"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor={descriptionId} className="text-xs font-bold uppercase tracking-wider text-solid-gray-700">
                {t('videos.courses.descriptionLabel')}
                <span className="ml-1 normal-case font-normal text-solid-gray-600">
                  {t('videos.courses.optional')}
                </span>
              </label>
              <input
                id={descriptionId}
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('videos.courses.descriptionPlaceholder')}
                disabled={isCreating}
                className="w-full rounded-8 border border-solid-gray-600 bg-white px-4 py-3 text-sm text-solid-gray-800 placeholder:text-solid-gray-600 focus:outline focus:outline-4 focus:outline-black focus:outline-offset-[calc(2/16*1rem)] focus:ring-[calc(2/16*1rem)] focus:ring-yellow-300 disabled:border-solid-gray-300 disabled:bg-solid-gray-50 disabled:text-solid-gray-420 disabled:placeholder:text-solid-gray-420 disabled:forced-colors:border-[GrayText] disabled:forced-colors:text-[GrayText]"
              />
            </div>
          </div>
        </DialogBody>

        <DialogActions>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={handleClose} disabled={isCreating}>
              {t('common.actions.cancel')}
            </Button>
            <Button onClick={() => { void handleCreate(); }} disabled={!name.trim() || isCreating}>
              {isCreating ? (
                <span className="flex items-center justify-center">
                  <InlineSpinner className="mr-2" />
                  {t('common.actions.creating')}
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
