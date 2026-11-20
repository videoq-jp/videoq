import { saveVideoEdits } from '@/application/video-editing';
import { useState, useCallback, useLayoutEffect, useRef, type SetStateAction } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Video } from '@videoq/trpc';
import { appTrpcClient } from '@/lib/trpc';
import { invalidateAfterVideoUpdate } from '@/lib/cacheInvalidation';

interface UseVideoEditingOptions {
  video: Video | null;
  videoId: number | null;
}

type VideoDraft = { title?: string; description?: string; tagIds?: number[] };

export function useVideoEditing({ video, videoId }: UseVideoEditingOptions) {
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<VideoDraft>({});
  const latestTags = useRef(video?.tags);
  useLayoutEffect(() => { latestTags.current = video?.tags; }, [video?.tags]);
  const editedTitle = draft.title ?? video?.title ?? '';
  const editedDescription = draft.description ?? video?.description ?? '';
  const editedTagIds = draft.tagIds ?? video?.tags?.map(tag => tag.id) ?? [];
  const setEditedTitle = useCallback((title: string) => setDraft(current => ({ ...current, title })), []);
  const setEditedDescription = useCallback((description: string) => setDraft(current => ({ ...current, description })), []);
  const setEditedTagIds = useCallback((value: SetStateAction<number[]>) => {
    // Tag creation can complete after the server data has changed.
    const tagIds = latestTags.current?.map(tag => tag.id) ?? [];
    setDraft(current => ({
      ...current,
      tagIds: typeof value === 'function' ? value(current.tagIds ?? tagIds) : value,
    }));
  }, []);

  const updateMutation = useMutation({
    mutationFn: () => saveVideoEdits(videoId, video, {
      title: editedTitle, description: editedDescription, tagIds: editedTagIds,
    }, {
      updateMetadata: input => appTrpcClient.videos.update.mutate(input),
      addTags: input => appTrpcClient.memberships.addTags.mutate(input),
      removeTag: input => appTrpcClient.memberships.removeTag.mutate(input),
      refresh: (id, result) => invalidateAfterVideoUpdate(queryClient, id, result),
    }),
    onSuccess: () => setIsEditing(false),
  });
  const { reset } = updateMutation;

  const startEditing = useCallback(() => {
    if (video) {
      setDraft({});
      reset();
      setIsEditing(true);
    }
  }, [video, reset]);

  const cancelEditing = useCallback(() => {
    setIsEditing(false);
    setDraft({});
    reset();
  }, [reset]);

  return {
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
  };
}
