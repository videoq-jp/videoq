import { useQueryClient, useMutation } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { parseResourceId } from '@videoq/trpc/schema';
import { useI18nNavigate } from '@/lib/i18n';
import { filterTranscriptSegments, parseSrtTranscript, type TranscriptSegment } from '@/lib/transcript/srt';
import { seekAndPlay } from '@/lib/video/playback';
import { trpc } from '@/lib/trpc';
import { useConfirm } from '@/components/common/feedback';
import { VideoDetailView } from '@/components/video/detail/VideoDetailView';
import { useTags } from '@/hooks/useTags';
import { useVideo } from '@/hooks/useVideos';
import { useVideoEditing } from '@/hooks/useVideoEditing';
import { useMobileTab } from '@/hooks/useMobileTab';
import { invalidateAfterVideoDelete, invalidateAfterVideoUpdate } from '@/lib/cacheInvalidation';

type MobileTab = 'transcript' | 'video';

export default function VideoDetailPage() {
  const params = useParams<{ id: string }>();
  const navigate = useI18nNavigate();
  const [searchParams] = useSearchParams();
  const videoId = parseResourceId(params.id);
  const videoRef = useRef<HTMLVideoElement>(null);
  const parsedStartTime = Number(searchParams.get('t') ?? Number.NaN);
  const queryStartSeconds = Number.isFinite(parsedStartTime) && parsedStartTime >= 0 ? parsedStartTime : null;
  const [youtubeSeek, setYoutubeSeek] = useState<{ seconds: number; id: number } | null>(null);
  const { t } = useTranslation();
  const requestConfirmation = useConfirm();
  const queryClient = useQueryClient();

  const [transcriptSearch, setTranscriptSearch] = useState('');
  const [isTranscriptEditing, setIsTranscriptEditing] = useState(false);
  const [editedTranscript, setEditedTranscript] = useState('');
  const [transcriptSaveError, setTranscriptSaveError] = useState<string | null>(null);
  const [activeSegment, setActiveSegment] = useState<TranscriptSegment | null>(null);
  const { mobileTab, setMobileTab, isMobile } = useMobileTab<MobileTab>('video');

  const { video, isLoading, error } = useVideo(videoId);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);

  const {
    isEditing,
    editedTitle,
    editedDescription,
    editedTagIds,
    setEditedTitle,
    setEditedDescription,
    setEditedTagIds,
    startEditing,
    cancelEditing,
    updateMutation,
  } = useVideoEditing({ video, videoId });
  const { tags, createTag } = useTags({ enabled: isEditing });

  const handleCreateTag = useCallback(async (name: string, color: string) => {
    const newTag = await createTag(name, color);
    setEditedTagIds((prev) => (prev.includes(newTag.id) ? prev : [...prev, newTag.id]));
  }, [createTag, setEditedTagIds]);

  const handleVideoLoaded = () => {
    if (videoRef.current && queryStartSeconds !== null) {
      seekAndPlay(videoRef.current, queryStartSeconds);
    }
  };

  const youtubeStartSeconds = youtubeSeek?.seconds ?? queryStartSeconds;

  const [deleteError, setDeleteError] = useState<string | null>(null);

  const deleteMutation = useMutation(trpc.videos.delete.mutationOptions({
    onSuccess: (_data, { id }) => invalidateAfterVideoDelete(queryClient, id),
    onError: (err) => setDeleteError(err.message),
  }));

  const isDeleting = deleteMutation.isPending;
  const isUpdating = updateMutation.isPending;
  const updateError = updateMutation.error instanceof Error ? updateMutation.error.message : null;

  const handleDeleteVideo = useCallback(async () => {
    const confirmed = await requestConfirmation({
      title: t('confirmations.deleteVideo'),
      confirmLabel: t('common.actions.delete'),
      variant: 'danger',
    });
    if (!confirmed) return;
    setDeleteError(null);
    if (videoId) deleteMutation.mutate({ id: videoId }, {
      onSuccess: () => navigate('/videos'),
    });
  }, [requestConfirmation, deleteMutation, navigate, t, videoId]);

  const transcriptUpdateMutation = useMutation(trpc.videos.update.mutationOptions({
    onSuccess: async (updatedVideo, { id }) => {
      await invalidateAfterVideoUpdate(queryClient, id, { metadataChanged: false, updatedVideo });
      setIsTranscriptEditing(false);
      setTranscriptSearch('');
      setTranscriptSaveError(null);
    },
    onError: (err: unknown) => {
      setTranscriptSaveError(err instanceof Error ? err.message : String(err));
    },
  }));

  const startTranscriptEditing = () => {
    setEditedTranscript(video?.transcript ?? '');
    setTranscriptSaveError(null);
    setIsTranscriptEditing(true);
  };

  const cancelTranscriptEditing = () => {
    setEditedTranscript(video?.transcript ?? '');
    setTranscriptSaveError(null);
    setIsTranscriptEditing(false);
  };

  const transcript = video?.transcript ?? '';
  const transcriptSegments = useMemo(() => parseSrtTranscript(transcript), [transcript]);
  const isPlainTextTranscript = transcriptSegments.length === 0 && transcript.trim().length > 0;

  const filteredSegments = useMemo(
    () => filterTranscriptSegments(transcriptSegments, transcriptSearch),
    [transcriptSegments, transcriptSearch],
  );

  const handleSeek = (seconds: number, idx: number) => {
    if (video?.source_type === 'youtube') {
      setYoutubeSeek(previous => ({ seconds, id: (previous?.id ?? 0) + 1 }));
    } else if (videoRef.current) {
      seekAndPlay(videoRef.current, seconds);
    }
    setActiveSegment(filteredSegments[idx]);
  };

  return (
    <VideoDetailView
      video={video}
      isLoading={isLoading}
      error={error}
      videoRef={videoRef}
      youtubeStartSeconds={youtubeStartSeconds}
      youtubeSeekId={youtubeSeek?.id ?? 0}
      onVideoLoaded={handleVideoLoaded}
      isMobile={isMobile}
      mobileTab={mobileTab}
      onMobileTabChange={setMobileTab}
      tags={tags}
      isCreateDialogOpen={isCreateDialogOpen}
      onCreateDialogOpenChange={setIsCreateDialogOpen}
      onCreateTag={handleCreateTag}
      isEditing={isEditing}
      editedTitle={editedTitle}
      editedDescription={editedDescription}
      editedTagIds={editedTagIds}
      onEditedTitleChange={setEditedTitle}
      onEditedDescriptionChange={setEditedDescription}
      onEditedTagIdsChange={setEditedTagIds}
      onStartEditing={startEditing}
      onCancelEdit={cancelEditing}
      onUpdateVideo={() => updateMutation.mutate()}
      isUpdating={isUpdating}
      updateError={updateError}
      deleteError={deleteError}
      isDeleting={isDeleting}
      onDeleteVideo={() => { void handleDeleteVideo(); }}
      transcriptSearch={transcriptSearch}
      onTranscriptSearchChange={setTranscriptSearch}
      isTranscriptEditing={isTranscriptEditing}
      onStartTranscriptEditing={startTranscriptEditing}
      onCancelTranscriptEditing={cancelTranscriptEditing}
      editedTranscript={editedTranscript}
      onEditedTranscriptChange={setEditedTranscript}
      onSaveTranscript={() => {
        if (editedTranscript === transcript) {
          cancelTranscriptEditing();
          setTranscriptSearch('');
        } else if (videoId) {
          transcriptUpdateMutation.mutate({ id: videoId, transcript: editedTranscript });
        }
      }}
      isTranscriptSaving={transcriptUpdateMutation.isPending}
      transcriptSaveError={transcriptSaveError}
      filteredSegments={filteredSegments}
      activeSegmentIdx={activeSegment ? filteredSegments.indexOf(activeSegment) : null}
      onSeek={handleSeek}
      isPlainTextTranscript={isPlainTextTranscript}
    />
  );
}
