import { features } from "@/lib/deployment";
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVideoUpload } from '@/hooks/useVideoUpload';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogHeading,
  DialogScrollArea,
  useDialog,
} from '@/components/ui/dialog';
import { MessageAlert } from '@/components/common/MessageAlert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RequirementBadge } from '@/components/ui/requirement-badge';
import { Textarea } from '@/components/ui/textarea';
import { VideoUploadFormFields } from './VideoUploadFormFields';
import { VideoUploadButton } from './VideoUploadButton';
import { useTags } from '@/hooks/useTags';
import { TagSelector } from './TagSelector';
import { TagCreateDialog } from './TagCreateDialog';

interface VideoUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** null keeps the success result open until the user closes it. */
  autoCloseDelayMs?: number | null;
}

/**
 * Render a modal dialog for uploading a video with title, description, file selection,
 * tag selection, and tag creation.
 *
 * The modal disables closing while an upload is in progress and automatically closes 2 seconds
 * after a successful upload. The upload hook handles refreshing affected queries.
 */
export function VideoUploadModal({ isOpen, onClose, autoCloseDelayMs = 2000 }: VideoUploadModalProps) {
  const {
    transcriptionLanguage,
    setTranscriptionLanguage,
    sourceMode,
    youtubeUrl,
    title,
    description,
    tagIds,
    isUploading,
    isCompressing,
    compressionPreset,
    compressionSupported,
    compressedSizes,
    setCompressionPreset,
    cancelCompression,
    progress,
    error,
    errorParams,
    warning,
    success,
    setTitle,
    setDescription,
    setYoutubeUrl,
    setSourceMode,
    setTagIds,
    handleFileChange,
    handleSubmit,
    reset,
  } = useVideoUpload();
  const { t } = useTranslation();
  const { tags, createTag } = useTags({ enabled: isOpen });
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);

  const handleTagToggle = useCallback((tagId: number) => {
    setTagIds((prev: number[]) =>
      prev.includes(tagId) ? prev.filter((id: number) => id !== tagId) : [...prev, tagId]
    );
  }, [setTagIds]);

  const handleCreateTag = useCallback(async (name: string, color: string) => {
    await createTag(name, color);
  }, [createTag]);

  const dialog = useDialog({
    open: isOpen,
    onOpenChange: (open) => {
      if (!open) handleClose();
    },
    onRequestClose: (event) => {
      if (isUploading) event.preventDefault();
    },
  });

  const handleClose = useCallback(() => {
    if (!isUploading) {
      dialog.dialogProps.ref.current?.close();
      reset();
      setIsCreateDialogOpen(false);
      onClose();
    }
  }, [isUploading, onClose, reset, dialog.dialogProps.ref]);

  useEffect(() => {
    if (isOpen && success && autoCloseDelayMs !== null) {
      const timer = setTimeout(() => {
        handleClose();
      }, autoCloseDelayMs);
      return () => clearTimeout(timer);
    }
  }, [isOpen, success, autoCloseDelayMs, handleClose]);

  if (!isOpen) return null;

  return (
    <>
      <Dialog {...dialog.dialogProps} scroll="inner" width="min(36rem, 92vw)">
        <DialogContent>
          <DialogHeader>
            <DialogHeading {...dialog.headingProps}>
              {t('videos.upload.title')}
            </DialogHeading>
          </DialogHeader>

          <form
            className="flex min-h-0 flex-col gap-4"
            onSubmit={(e) => {
              // The hook has already exposed mutation errors through `error`.
              void handleSubmit(e).catch(() => undefined);
            }}
          >
            <DialogScrollArea>
              <DialogBody>
                <p className="mb-4 text-std-16N-170 text-solid-gray-700">
                  {t('videos.upload.description')}
                </p>

                <div className="space-y-4">
                  <div className="flex border-b border-solid-gray-420">
                    {(['file', ...(features.youtube ? ['youtube'] as const : [])] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        disabled={isUploading}
                        aria-pressed={sourceMode === mode}
                        onClick={() => setSourceMode(mode)}
                        className={`flex-1 px-3 py-2 text-sm font-semibold transition-colors ${
                          sourceMode === mode
                            ? 'border-b-2 border-key-900 text-key-900'
                            : 'text-solid-gray-700 hover:text-solid-gray-800'
                        }`}
                      >
                        {mode === 'file' ? t('videos.upload.modes.file') : t('videos.upload.modes.youtube')}
                      </button>
                    ))}
                  </div>

                  {sourceMode === 'file' ? (
                    <VideoUploadFormFields
                      transcriptionLanguage={transcriptionLanguage}
                      setTranscriptionLanguage={setTranscriptionLanguage}
                      title={title}
                      description={description}
                      isUploading={isUploading}
                      isCompressing={isCompressing}
                      compressionPreset={compressionPreset}
                      compressionSupported={compressionSupported}
                      compressedSizes={compressedSizes}
                      setCompressionPreset={setCompressionPreset}
                      progress={progress}
                      error={error}
                      errorParams={errorParams}
                      warning={warning}
                      success={success}
                      setTitle={setTitle}
                      setDescription={setDescription}
                      handleFileChange={handleFileChange}
                      hideButtons={true}
                    />
                  ) : (
                    <div className="space-y-4">
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="youtube_url">
                          {t('videos.upload.youtubeUrlLabel')}
                          <RequirementBadge>{t('common.labels.required')}</RequirementBadge>
                        </Label>
                        <Input
                          id="youtube_url"
                          type="url"
                          value={youtubeUrl}
                          onChange={(e) => setYoutubeUrl(e.target.value)}
                          disabled={isUploading}
                          blockSize="md"
                          required
                        />
                      </div>
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="youtube-title">
                          {t('videos.upload.titleLabel')}
                          <RequirementBadge>{t('common.labels.required')}</RequirementBadge>
                        </Label>
                        <Input
                          id="youtube-title"
                          type="text"
                          value={title}
                          onChange={(e) => setTitle(e.target.value)}
                          disabled={isUploading}
                          blockSize="md"
                          required
                        />
                      </div>
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="youtube-description">
                          {t('videos.upload.descriptionLabel')}
                          <RequirementBadge isOptional>{t('common.labels.optional')}</RequirementBadge>
                        </Label>
                        <Textarea
                          id="youtube-description"
                          value={description}
                          onChange={(e) => setDescription(e.target.value)}
                          disabled={isUploading}
                          rows={4}
                          className="resize-none"
                        />
                      </div>
                      {error && (
                        <MessageAlert
                          type="error"
                          message={t(error, { defaultValue: error, ...errorParams })}
                        />
                      )}
                      {warning && (
                        <MessageAlert
                          type="warning"
                          message={t(warning, { defaultValue: warning })}
                        />
                      )}
                      {success && <MessageAlert type="success" message={t('videos.upload.success')} />}
                    </div>
                  )}

                  <TagSelector
                    tags={tags}
                    selectedTagIds={tagIds}
                    onToggle={handleTagToggle}
                    onCreateNew={() => setIsCreateDialogOpen(true)}
                    disabled={isUploading}
                  />
                </div>
              </DialogBody>
            </DialogScrollArea>

            <DialogActions>
              <div className="flex flex-wrap justify-end gap-3">
                <Button type="button" variant="outline" onClick={isCompressing ? cancelCompression : handleClose} disabled={isUploading && !isCompressing}>
                  {t(isCompressing ? 'videos.upload.compression.cancel' : 'common.actions.cancel')}
                </Button>
                <VideoUploadButton isUploading={isUploading} isCompressing={isCompressing}
                  disabled={sourceMode === 'file' && !compressionSupported} compressionSelected={sourceMode === 'file'} progress={progress} />
              </div>
            </DialogActions>
          </form>
        </DialogContent>
      </Dialog>

      <TagCreateDialog
        isOpen={isCreateDialogOpen}
        onClose={() => setIsCreateDialogOpen(false)}
        onCreate={handleCreateTag}
      />
    </>
  );
}
