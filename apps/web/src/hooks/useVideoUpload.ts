import { MAX_VIDEO_UPLOAD_BYTES, type TranscriptionLanguage } from '@videoq/trpc/video-upload';
import { useState, useCallback, useRef, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { getApiError } from '@/lib/api-error';
import { invalidateAfterVideoUpload } from '@/lib/cacheInvalidation';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { appTrpcClient } from '@/lib/trpc';
import { trackLandingEvent } from '@/lib/landingAnalytics';
import { compressVideo, supportsVideoCompression, type CompressionPreset } from '@/lib/videoCompression';
import {
  prepareVideoUpload,
  runUploadWorkflow,
  type PreparedUpload,
  type UploadSourceMode,
} from '@/lib/videoUpload';

interface UseVideoUploadReturn {
  transcriptionLanguage: TranscriptionLanguage | 'auto';
  setTranscriptionLanguage: (language: TranscriptionLanguage | 'auto') => void;
  sourceMode: UploadSourceMode;
  youtubeUrl: string;
  title: string;
  description: string;
  tagIds: number[];
  isUploading: boolean;
  isCompressing: boolean;
  compressionPreset: CompressionPreset;
  compressionSupported: boolean;
  compressedSizes: { before: number; after: number } | null;
  setCompressionPreset: (preset: CompressionPreset) => void;
  cancelCompression: () => void;
  progress: number;
  error: string | null;
  errorParams: Record<string, unknown>;
  warning: string | null;
  success: boolean;
  setTitle: (title: string) => void;
  setDescription: (description: string) => void;
  setYoutubeUrl: (url: string) => void;
  setSourceMode: (mode: UploadSourceMode) => void;
  setTagIds: React.Dispatch<React.SetStateAction<number[]>>;
  handleFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleSubmit: (e: React.FormEvent) => Promise<void>;
  reset: () => void;
}

interface RunUploadMutationVariables {
  upload: PreparedUpload;
  tagIds: number[];
}

export function useVideoUpload(): UseVideoUploadReturn {
  const { user } = useAuth();
  const { i18n } = useTranslation();
  const locale = (i18n.resolvedLanguage ?? i18n.language).startsWith('en') ? 'en' : 'ja';
  const [languageOverride, setLanguageOverride] = useState<TranscriptionLanguage | 'auto' | null>(null);
  const transcriptionLanguage = languageOverride ?? locale;
  const [sourceMode, setSourceMode] = useState<UploadSourceMode>('file');
  const [file, setFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorParams, setErrorParams] = useState<Record<string, unknown>>({});
  const [warning, setWarning] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [compressionPreset, setPreset] = useState<CompressionPreset>('1080p');
  const [isCompressing, setIsCompressing] = useState(false);
  const [compressedSizes, setCompressedSizes] = useState<{ before: number; after: number } | null>(null);
  const compressionAbort = useRef<AbortController | null>(null);
  useEffect(() => () => compressionAbort.current?.abort(), []);
  const uploadInFlight = useRef(false);
  const queryClient = useQueryClient();

  const uploadMutation = useMutation({
    mutationFn: ({ upload, tagIds }: RunUploadMutationVariables) =>
      runUploadWorkflow(upload, tagIds, {
        uploadVideo: (data, onProgress) => apiClient.uploadVideo(data, onProgress),
        createYoutubeVideo: appTrpcClient.videos.createYoutube.mutate,
        addTagsToVideo: appTrpcClient.memberships.addTags.mutate,
      }, setProgress),
    onSuccess: async (warning, { tagIds }) => {
      // Acceptance is distinct from completion of transcription/indexing.
      trackLandingEvent('video_upload_accepted');
      setSuccess(true);
      setError(null);
      setErrorParams({});
      setWarning(warning);
      setProgress(100);
      await invalidateAfterVideoUpload(queryClient, { tagsChanged: tagIds.length > 0 });
    },
    onError: (err) => {
      trackLandingEvent('video_upload_failed');
      const apiError = getApiError(err);
      if (apiError?.code === 'FILE_TOO_LARGE') {
        setError('videos.upload.validation.fileTooLarge');
        setErrorParams(apiError.params ?? {});
      } else if (apiError?.code === 'MONTHLY_UPLOAD_LIMIT_EXCEEDED') {
        setError('videos.upload.validation.monthlyUploadLimitExceeded');
        setErrorParams({});
      } else if (apiError?.code === 'STORAGE_LIMIT_EXCEEDED') {
        setError('videos.upload.validation.storageLimitExceeded');
        setErrorParams({});
      } else {
        setError(err instanceof Error ? err.message : String(err));
        setErrorParams({});
      }
      setWarning(null);
      setProgress(0);
    },
  });

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (sourceMode !== 'file') {
      return;
    }
    if (e.target.files && e.target.files[0]) {
      const selectedFile = e.target.files[0];
      const validation = prepareVideoUpload({
        source: 'file',
        file: selectedFile,
        title: '',
        description: '',
        maxSizeMb: Infinity,
      });
      if (!validation.isValid) {
        setFile(null);
        setTitle('');
        setError(validation.error);
        setErrorParams(validation.errorParams ?? {});
        setWarning(null);
        return;
      }

      setError(null);
      setErrorParams({});
      setWarning(null);
      setFile(selectedFile);
      setCompressedSizes(null);
      // Automatically set filename (without extension) as title
      setTitle(validation.upload.data.title);
    }
  }, [sourceMode]);

  const setCompressionPreset = useCallback((preset: CompressionPreset) => {
    if (uploadInFlight.current) return;
    setPreset(preset);
    setCompressedSizes(null);
    setError(null);
    setErrorParams({});
  }, []);

  const reset = useCallback(() => {
    setSourceMode('file');
    setLanguageOverride(null);
    setFile(null);
    setYoutubeUrl('');
    setTitle('');
    setDescription('');
    setTagIds([]);
    setSuccess(false);
    setError(null);
    setErrorParams({});
    setWarning(null);
    setProgress(0);
    setPreset('1080p');
    setCompressedSizes(null);
  }, []);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (uploadInFlight.current) return;

    // Clear any progress left over from a previous submission before the
    // pending state flips, so the button never flashes a stale percentage.
    setProgress(0);

    const validation = prepareVideoUpload(sourceMode === 'youtube'
      ? { source: 'youtube', youtubeUrl, title, description }
      : { source: 'file', file, title, description, maxSizeMb: Infinity, transcriptionLanguage: transcriptionLanguage === 'auto' ? undefined : transcriptionLanguage });
    if (!validation.isValid) {
      setError(validation.error);
      setErrorParams(validation.errorParams ?? {});
      setWarning(null);
      return;
    }

    setError(null);
    setErrorParams({});
    setWarning(null);
    setSuccess(false);
    // Guard before React renders the pending state, including cache refreshes.
    uploadInFlight.current = true;
    let compressed: Awaited<ReturnType<typeof compressVideo>> | undefined;
    try {
      if (validation.upload.source === 'file') {
        const storageRemaining = user?.storage_limit_bytes == null ? Infinity
          : Math.max(0, user.storage_limit_bytes - (user.used_storage_bytes ?? 0));
        // Do not let a cached account response from the previous month block a new one.
        const uploadUsed = user?.upload_resets_at && Date.parse(user.upload_resets_at) <= Date.now()
          ? 0 : user?.used_upload_bytes ?? 0;
        const monthlyRemaining = user?.monthly_upload_limit_bytes == null ? Infinity
          : Math.max(0, user.monthly_upload_limit_bytes - uploadUsed);
        const maxCompressedBytes = Math.min(MAX_VIDEO_UPLOAD_BYTES, storageRemaining, monthlyRemaining);
        if (maxCompressedBytes <= 0) {
          setError(storageRemaining <= 0 ? 'videos.upload.validation.storageLimitExceeded' : 'videos.upload.validation.monthlyUploadLimitExceeded');
          return;
        }
        const controller = new AbortController();
        compressionAbort.current = controller;
        setIsCompressing(true);
        setCompressedSizes(null);
        try {
          compressed = await compressVideo(validation.upload.data.file, compressionPreset, {
            signal: controller.signal, onProgress: setProgress, maxBytes: maxCompressedBytes,
          });
          controller.signal.throwIfAborted();
          // The server atomically reserves storage and monthly usage for these actual bytes.
          if (compressed.file.size > maxCompressedBytes) throw new Error('videos.upload.compression.tooLarge');
          setCompressedSizes({ before: validation.upload.data.file.size, after: compressed.file.size });
          validation.upload.data.file = compressed.file;
        } catch (error) {
          setError(error instanceof DOMException && error.name === 'AbortError'
            ? 'videos.upload.compression.canceled'
            : error instanceof Error ? error.message : 'videos.upload.compression.failed');
          setProgress(0);
          return;
        } finally {
          compressionAbort.current = null;
          setIsCompressing(false);
        }
        setProgress(0);
      }
      trackLandingEvent('video_upload_started');
      await uploadMutation.mutateAsync({ upload: validation.upload, tagIds });
    } finally {
      await compressed?.dispose();
      uploadInFlight.current = false;
    }
  }, [sourceMode, youtubeUrl, title, description, file, user, tagIds, uploadMutation, compressionPreset, transcriptionLanguage]);

  return {
    transcriptionLanguage,
    setTranscriptionLanguage: setLanguageOverride,
    sourceMode,
    youtubeUrl,
    title,
    description,
    tagIds,
    isUploading: uploadMutation.isPending || isCompressing,
    isCompressing,
    compressionPreset,
    compressionSupported: supportsVideoCompression(),
    compressedSizes,
    setCompressionPreset,
    cancelCompression: () => compressionAbort.current?.abort(),
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
  };
}
