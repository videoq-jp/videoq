import { useQueryClient, useMutation } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { parseResourceId } from '@videoq/trpc/schema';
import { arrayMove } from '@dnd-kit/sortable';
import type { DragEndEvent } from '@dnd-kit/core';
import { useI18nNavigate } from '@/lib/i18n';
import { handleAsyncError } from '@/lib/utils/errorHandling';
import { useShareLink } from '@/hooks/useShareLink';
import { useVideoPlayback } from '@/hooks/useVideoPlayback';
import { useMobileTab } from '@/hooks/useMobileTab';
import {
  useVideoCourseDetailMutations,
  useVideoCourseDetailQuery,
} from '@/hooks/useVideoCourseDetailData';
import { useConfirm, useToast } from '@/components/common/feedback';
import { VideoCourseDetailView } from '@/components/video/course-detail/VideoCourseDetailView';
import { trpc } from '@/lib/trpc';
import { invalidateAfterCourseRemoval } from '@/lib/cacheInvalidation';

export default function VideoCourseDetailPage() {
  const params = useParams<{ id: string }>();
  const navigate = useI18nNavigate();
  const courseId = parseResourceId(params.id);
  const { t } = useTranslation();
  const requestConfirmation = useConfirm();
  const toast = useToast();
  const queryClient = useQueryClient();
  const leaveCourseMutation = useMutation(trpc.courseMemberships.leave.mutationOptions({
    onSuccess: (_data, { courseId }) => invalidateAfterCourseRemoval(queryClient, courseId),
  }));

  const { course, isLoading: courseIsLoading, errorMessage: error } =
    useVideoCourseDetailQuery(courseId);

  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isMembersModalOpen, setIsMembersModalOpen] = useState(false);
  const [selectedVideoId, setSelectedVideoId] = useState<number | null>(null);
  const [autoVideoId, setAutoVideoId] = useState<number | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<{ name?: string; description?: string }>({});
  const editedName = draft.name ?? course?.name ?? '';
  const editedDescription = draft.description ?? course?.description ?? '';

  const currentVideos = course?.videos;
  const firstVideoId = currentVideos?.[0]?.id ?? null;
  const autoVideoInList = autoVideoId !== null && (currentVideos?.some((video) => video.id === autoVideoId) ?? false);
  if (!autoVideoInList && firstVideoId !== null) {
    setAutoVideoId(firstVideoId);
  }

  const selectedVideo = useMemo(() => {
    const videos = course?.videos;
    if (!videos || videos.length === 0) return null;

    if (selectedVideoId !== null) {
      const found = videos.find((video) => video.id === selectedVideoId);
      if (found) return found;
    }

    if (autoVideoId !== null) {
      const found = videos.find((video) => video.id === autoVideoId);
      if (found) return found;
    }

    return videos[0];
  }, [course?.videos, selectedVideoId, autoVideoId]);

  const { mobileTab, setMobileTab, isMobile } = useMobileTab<'videos' | 'player'>('player');
  const { shareLink, isGeneratingLink, isDeletingLink, isCopied, generateShareLink, deleteShareLink, copyShareLink } = useShareLink(course);

  const { videoRef, handleVideoSelect, handleVideoCanPlay, handleVideoPlayFromTime, youtubeStartSeconds, youtubeSeekId } = useVideoPlayback({
    selectedVideo,
    onVideoSelect: setSelectedVideoId,
    onMobileSwitch: () => setMobileTab('player'),
  });

  const { removeVideoMutation, reorderVideosMutation, deleteCourseMutation, updateCourseMutation } =
    useVideoCourseDetailMutations({
      courseId,
      onUpdateSuccess: () => setIsEditing(false),
    });

  const handleRemoveVideo = async (videoId: number) => {
    if (!courseId || reorderVideosMutation.isPending || removeVideoMutation.isPending || deleteCourseMutation.isPending) return;
    const confirmed = await requestConfirmation({
      title: t('videos.courseDetail.removeVideoConfirm'),
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await removeVideoMutation.mutateAsync(videoId);
      if (selectedVideoId === videoId) setSelectedVideoId(null);
    } catch (err) {
      handleAsyncError(err, t('videos.courseDetail.removeVideoError'), (message) => toast({ message, variant: 'error' }));
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (reorderVideosMutation.isPending || removeVideoMutation.isPending || deleteCourseMutation.isPending) return;
    if (!over || active.id === over.id || !course?.videos || !courseId) return;
    const oldIndex = course.videos.findIndex((video) => video.id === active.id);
    const newIndex = course.videos.findIndex((video) => video.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const newVideos = arrayMove(course.videos, oldIndex, newIndex);
    try {
      await reorderVideosMutation.mutateAsync(newVideos.map((video) => video.id));
    } catch (err) {
      handleAsyncError(err, t('videos.courseDetail.orderUpdateError'), (message) => toast({ message, variant: 'error' }));
    }
  };

  const handleDelete = async () => {
    if (!courseId) return;
    const confirmed = await requestConfirmation({
      title: t('confirmations.deleteCourse'),
      confirmLabel: t('common.actions.delete'),
      variant: 'danger',
    });
    if (!confirmed) return;
    setDeleteError(null);
    deleteCourseMutation.mutate(undefined, {
      onSuccess: () => navigate('/videos/courses'),
      onError: (err) => handleAsyncError(err, t('videos.courseDetail.deleteError'), setDeleteError),
    });
  };

  const handleStartEdit = () => {
    if (!course) return;
    setDraft({});
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    updateCourseMutation.reset();
    setDraft({});
  };

  const isLoading = courseIsLoading;
  const isLeaving = leaveCourseMutation.isPending;
  const isDeleting = deleteCourseMutation.isPending;
  const isUpdating = updateCourseMutation.isPending;
  // `variables` holds the videoId passed to mutateAsync, so the list can show a
  // spinner on the row being removed instead of on every remove button.
  const removingVideoId = removeVideoMutation.isPending ? removeVideoMutation.variables ?? null : null;
  const updateError = updateCourseMutation.error instanceof Error ? updateCourseMutation.error.message : null;

  const handleLeave = async () => {
    if (!courseId || !course || isLeaving) return;
    const confirmed = await requestConfirmation({
      title: t('confirmations.leaveCourse', { name: course.name }),
      description: t('confirmations.leaveCourseDescription'),
      confirmLabel: t('videos.courseDetail.leave'),
      variant: 'danger',
    });
    if (!confirmed) return;
    setDeleteError(null);
    leaveCourseMutation.mutate({ courseId }, {
      onSuccess: () => navigate('/videos/courses'),
      onError: (err) => handleAsyncError(err, t('videos.courseDetail.leaveError'), setDeleteError),
    });
  };

  return (
    <VideoCourseDetailView
      course={course}
      courseId={courseId}
      isLoading={isLoading}
      error={error}
      selectedVideo={selectedVideo}
      deleteError={deleteError}
      isDeleting={isDeleting}
      isEditing={isEditing}
      editedName={editedName}
      editedDescription={editedDescription}
      updateError={updateError}
      isUpdating={isUpdating}
      isAddModalOpen={isAddModalOpen}
      isMembersModalOpen={isMembersModalOpen}
      isLeaving={isLeaving}
      mobileTab={mobileTab}
      isMobile={isMobile}
      videoRef={videoRef}
      youtubeStartSeconds={youtubeStartSeconds}
      youtubeSeekId={youtubeSeekId}
      shareSlug={course?.share_slug ?? ''}
      shareLink={shareLink}
      isGeneratingLink={isGeneratingLink}
      isDeletingLink={isDeletingLink}
      isCopied={isCopied}
      onMobileTabChange={setMobileTab}
      onOpenAddModalChange={setIsAddModalOpen}
      onOpenMembersModalChange={setIsMembersModalOpen}
      onStartEditing={handleStartEdit}
      onCancelEdit={handleCancelEdit}
      onEditedNameChange={(name) => setDraft(current => ({ ...current, name }))}
      onEditedDescriptionChange={(description) => setDraft(current => ({ ...current, description }))}
      onUpdateCourse={() => updateCourseMutation.mutate(draft)}
      onDeleteCourse={() => { void handleDelete(); }}
      onLeaveGroup={() => { void handleLeave(); }}
      onVideoSelect={handleVideoSelect}
      onRemoveVideo={handleRemoveVideo}
      removingVideoId={removingVideoId}
      isReordering={reorderVideosMutation.isPending}
      onDragEnd={handleDragEnd}
      onVideoCanPlay={handleVideoCanPlay}
      onVideoPlayFromTime={handleVideoPlayFromTime}
      onGenerateShareLink={generateShareLink}
      onDeleteShareLink={() => { void deleteShareLink(); }}
      onCopyShareLink={() => { void copyShareLink(); }}
    />
  );
}
