import { useCallback, useRef, useState } from 'react';
import { fn, mocked } from 'storybook/test';
import { useVideoUpload } from '@/hooks/useVideoUpload';
import { useTranslation } from 'react-i18next';
import type { TranscriptionLanguage } from '@videoq/trpc/video-upload';
import type { CompressionPreset } from '@/lib/videoCompression';

export interface UploadScenario {
  result?: 'success' | 'pending' | 'error' | 'retry' | 'warning';
  progress?: number;
  error?: string;
  errorParams?: Record<string, string | number>;
  compressing?: boolean;
  compressionSupported?: boolean;
}
export const uploadRequest = fn();
export const uploadError = 'アップロードを完了できませんでした / Upload failed';

// Stateful UI fixture. Validation and transport remain covered by the real hook's tests.
function useUploadFixture(scenario: UploadScenario): ReturnType<typeof useVideoUpload> {
  const { i18n } = useTranslation();
  const locale = i18n.language.startsWith('en') ? 'en' : 'ja';
  const [languageOverride, setTranscriptionLanguage] = useState<TranscriptionLanguage | 'auto' | null>(null);
  const transcriptionLanguage = languageOverride ?? locale;
  const [sourceMode, setSourceMode] = useState<'file' | 'youtube'>('file');
  const [file, setFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [compressionPreset, setCompressionPreset] = useState<CompressionPreset>('1080p');
  const [isCompressing, setIsCompressing] = useState(false);
  const attempts = useRef(0);
  const reset = useCallback(() => {
    setTranscriptionLanguage(null);
    setSourceMode('file'); setFile(null); setYoutubeUrl(''); setTitle(''); setDescription('');
    setTagIds([]); setIsUploading(false); setProgress(0); setError(null); setSuccess(false); setWarning(null);
    setCompressionPreset('1080p'); setIsCompressing(false);
  }, []);
  return {
    transcriptionLanguage, setTranscriptionLanguage,
    sourceMode, youtubeUrl, title, description, tagIds, isUploading, progress, error, success, warning,
    compressionPreset, setCompressionPreset, isCompressing,
    compressionSupported: scenario.compressionSupported ?? true,
    compressedSizes: null,
    cancelCompression() { setIsCompressing(false); setIsUploading(false); setProgress(0); setError('videos.upload.compression.canceled'); },
    errorParams: error ? scenario.errorParams ?? {} : {},
    setSourceMode, setTitle, setDescription, setYoutubeUrl, setTagIds, reset,
    handleFileChange(event) {
      const selected = event.target.files?.[0];
      if (selected) { setFile(selected); setTitle(selected.name.replace(/\.[^/.]+$/, '')); setError(null); }
    },
    async handleSubmit(event) {
      event.preventDefault();
      uploadRequest({ sourceMode, fileName: file?.name ?? null, youtubeUrl, title, description, tagIds });
      setError(null); setWarning(null); setSuccess(false);
      attempts.current++;
      if (scenario.compressing && sourceMode === 'file') {
        setIsCompressing(true); setIsUploading(true); setProgress(scenario.progress ?? 36);
        return;
      }
      if (scenario.result === 'pending') {
        setIsUploading(true); setProgress(scenario.progress ?? (sourceMode === 'file' ? 46 : 0));
        return;
      }
      if (scenario.result === 'error' || (scenario.result === 'retry' && attempts.current === 1)) {
        setError(scenario.error ?? uploadError);
        // The real hook exposes the error and rejects mutateAsync; callers must handle it.
        throw new Error(uploadError);
      }
      setProgress(100); setSuccess(true);
      if (scenario.result === 'warning') setWarning('videos.upload.warning.tagsFailed');
    },
  };
}

export function installUploadFixture(scenario: UploadScenario = {}) {
  uploadRequest.mockClear();
  mocked(useVideoUpload).mockImplementation(function useStoryUpload() { return useUploadFixture(scenario); });
  return () => mocked(useVideoUpload).mockReset();
}
