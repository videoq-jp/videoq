import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RequirementBadge } from '@/components/ui/requirement-badge';
import { MessageAlert } from '@/components/common/MessageAlert';
import { Button } from '@/components/ui/button';
import { ProgressIndicator, ProgressIndicatorLinear } from '@/components/ui/progress-indicator';
import { VideoUploadButton } from './VideoUploadButton';
import { useTranslation } from 'react-i18next';
import { VIDEO_UPLOAD_TYPES, TRANSCRIPTION_LANGUAGES, type TranscriptionLanguage } from '@videoq/trpc/video-upload';
import type { CompressionPreset } from '@/lib/videoCompression';

const acceptedVideoTypes = Object.keys(VIDEO_UPLOAD_TYPES).join(',');

interface VideoUploadFormFieldsProps {
  transcriptionLanguage?: TranscriptionLanguage | 'auto';
  setTranscriptionLanguage?: (language: TranscriptionLanguage | 'auto') => void;
  title: string;
  description: string;
  isUploading: boolean;
  isCompressing?: boolean;
  compressionPreset?: CompressionPreset;
  compressionSupported?: boolean;
  setCompressionPreset?: (preset: CompressionPreset) => void;
  compressedSizes?: { before: number; after: number } | null;
  progress?: number;
  disabled?: boolean;
  error: string | null;
  errorParams?: Record<string, unknown>;
  warning?: string | null;
  success: boolean;
  setTitle: (title: string) => void;
  setDescription: (description: string) => void;
  handleFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  showCancelButton?: boolean;
  onCancel?: () => void;
  cancelButtonClassName?: string;
  hideButtons?: boolean;
  renderButtons?: () => React.ReactNode;
}

export function VideoUploadFormFields({
  transcriptionLanguage = 'auto',
  setTranscriptionLanguage,
  title,
  description,
  isUploading,
  isCompressing = false,
  compressionPreset = '1080p',
  compressionSupported = false,
  setCompressionPreset,
  compressedSizes,
  progress = 0,
  disabled = false,
  error,
  errorParams = {},
  warning = null,
  success,
  setTitle,
  setDescription,
  handleFileChange,
  showCancelButton = false,
  onCancel,
  cancelButtonClassName,
  hideButtons = false,
  renderButtons,
}: VideoUploadFormFieldsProps) {
  const { t } = useTranslation();
  const percent = Math.round(progress);

  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor="file">
          {t('videos.upload.fileLabel')}
          <RequirementBadge>{t('common.labels.required')}</RequirementBadge>
        </Label>
        <Input
          id="file"
          type="file"
          accept={acceptedVideoTypes}
          onChange={handleFileChange}
          disabled={isUploading || disabled}
          required
        />
      </div>

      {setTranscriptionLanguage && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="transcription-language">{t('videos.upload.languageLabel')}</Label>
          <select id="transcription-language" value={transcriptionLanguage}
            onChange={event => setTranscriptionLanguage(event.target.value as TranscriptionLanguage | 'auto')}
            disabled={isUploading || disabled} aria-describedby="transcription-language-help"
            className="h-12 rounded-8 border border-solid-gray-600 bg-white px-4 text-std-16N-170">
            {Object.entries(TRANSCRIPTION_LANGUAGES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            <option value="auto">{t('videos.upload.languageAuto')}</option>
          </select>
          <p id="transcription-language-help" className="text-std-14N-170 text-solid-gray-700">{t('videos.upload.languageHelp')}</p>
        </div>
      )}

      {setCompressionPreset && (
        <fieldset className="space-y-2" disabled={isUploading || disabled}>
          <legend className="font-bold">{t('videos.upload.compression.label')}</legend>
          {(['1080p', '720p'] as const).map(preset => (
            <label key={preset} className="flex items-start gap-2 text-std-16N-170">
              <input type="radio" name="upload-compression" value={preset}
                checked={compressionPreset === preset}
                disabled={!compressionSupported}
                onChange={() => setCompressionPreset(preset)} className="mt-1.5 accent-key-900" />
              <span>{t(`videos.upload.compression.presets.${preset}`)}</span>
            </label>
          ))}
          {!compressionSupported && <p className="text-std-14N-170 text-solid-gray-700">
            {t('videos.upload.compression.unsupported')}
          </p>}
        </fieldset>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="title">
          {t('videos.upload.titleLabel')}
          <RequirementBadge>{t('common.labels.required')}</RequirementBadge>
        </Label>
        <Input
          id="title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={isUploading || disabled}
          required
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="description">
          {t('videos.upload.descriptionLabel')}
          <RequirementBadge isOptional>{t('common.labels.optional')}</RequirementBadge>
        </Label>
        <Textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={isUploading || disabled}
          className="min-h-[100px] resize-none"
        />
      </div>

      {error === 'videos.upload.compression.canceled'
        ? <p role="status" className="text-std-14N-170 text-solid-gray-700">{t(error)}</p>
        : error && <MessageAlert type="error" message={t(error, { defaultValue: error, ...errorParams })} />}
      {warning && <MessageAlert type="warning" message={t(warning, { defaultValue: warning })} />}
      {success && <MessageAlert type="success" message={t('videos.upload.success')} />}
      {compressedSizes && <p role="status" className="text-std-14N-170 text-solid-gray-700">
        {t(compressedSizes.after < compressedSizes.before ? 'videos.upload.compression.saved' : 'videos.upload.compression.sizes', {
          before: (compressedSizes.before / 1024 ** 3).toFixed(2),
          after: (compressedSizes.after / 1024 ** 3).toFixed(2),
          percent: Math.round((1 - compressedSizes.after / compressedSizes.before) * 100),
        })}
      </p>}

      {isUploading && (percent > 0 || isCompressing) && (
        <ProgressIndicator type="stacked" value={percent} aria-label={t(isCompressing ? 'videos.upload.compression.compressing' : 'videos.upload.uploading')}>
          <ProgressIndicatorLinear />
          <span className="text-std-14N-170 text-solid-gray-700">{isCompressing ? `${t('videos.upload.compression.compressing')} ${percent}%` : `${percent}%`}</span>
        </ProgressIndicator>
      )}

      {!hideButtons && (
        renderButtons ? (
          renderButtons()
        ) : showCancelButton ? (
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={isUploading || disabled}
              className={cancelButtonClassName}
            >
              {t('common.actions.cancel')}
            </Button>
            <VideoUploadButton isUploading={isUploading} isCompressing={isCompressing} compressionSelected progress={progress} disabled={disabled || (Boolean(setCompressionPreset) && !compressionSupported)} fullWidth className="flex-1" />
          </div>
        ) : (
          <VideoUploadButton isUploading={isUploading} isCompressing={isCompressing} compressionSelected progress={progress} disabled={disabled || (Boolean(setCompressionPreset) && !compressionSupported)} fullWidth />
        )
      )}
    </>
  );
}
