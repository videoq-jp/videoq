import { queryOptions, useQueryClient, useQuery, useMutation, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import type { Tag } from '@videoq/trpc';
import { loadTagCatalog } from '@/application/tag-catalog';
import { appTrpcClient, trpc } from '@/lib/trpc';
import { refreshQuery } from '@/lib/cacheInvalidation';
import {
  DEFAULT_TAG_CHIP_COLOR,
  isTagChipColor,
} from '@/lib/tagColors';

const compareTags = (left: Tag, right: Tag) => left.name.localeCompare(right.name) || left.id - right.id;

const allTagsOptions = queryOptions({
  // Keep the complete selector list distinct from individual API pages while
  // sharing tags.list invalidation and in-flight requests across consumers.
  queryKey: [...trpc.tags.list.pathKey(), { scope: 'all' }] as const,
  queryFn: async ({ signal }) => {
    const tags = await loadTagCatalog(async input => {
      const page = await appTrpcClient.tags.list.query(input, { signal });
      return { items: page.data, total: page.meta.total };
    });
    return tags.sort(compareTags);
  },
});

async function updateTagList(queryClient: QueryClient, update: (tags: Tag[]) => Tag[]) {
  const key = allTagsOptions.queryKey;
  const filter = { queryKey: key, exact: true };
  await queryClient.cancelQueries(filter);
  if (queryClient.getQueryData(key)) {
    queryClient.setQueryData(key, (tags) => tags && update(tags));
  } else {
    // A mutation can finish before the initial list. Load the complete list
    // instead of seeding a partial list containing only the changed tag.
    await queryClient.invalidateQueries(filter);
  }
}

export function useTags({ enabled = true }: { enabled?: boolean } = {}) {
  const queryClient = useQueryClient();

  const tagsQuery = useQuery({ ...allTagsOptions, enabled });

  const createTagMutation = useMutation(trpc.tags.create.mutationOptions({
    onSuccess: (newTag) => updateTagList(queryClient, (tags) => {
      const exists = tags.some((tag) => tag.id === newTag.id);
      // A concurrent refetch may already contain newer counts for this tag.
      return exists ? tags : [...tags, newTag].sort(compareTags);
    }),
  }));

  const deleteTagMutation = useMutation(trpc.tags.delete.mutationOptions({
    onSuccess: async (_result, { id }) => {
      await updateTagList(queryClient, (tags) => tags.filter((tag) => tag.id !== id));
      await Promise.all([
        refreshQuery(queryClient, trpc.videos.list.pathFilter()),
        refreshQuery(queryClient, trpc.videos.get.pathFilter()),
      ]);
    },
  }));

  const createTag = useCallback(
    async (name: string, color?: string) => {
      const selectedColor = color ?? DEFAULT_TAG_CHIP_COLOR;
      if (!isTagChipColor(selectedColor)) {
        throw new Error(`Invalid tag color: ${selectedColor}`);
      }

      return createTagMutation.mutateAsync({
        name,
        color: selectedColor,
      });
    },
    [createTagMutation]
  );

  const deleteTag = useCallback(
    async (id: number) => {
      await deleteTagMutation.mutateAsync({ id });
    },
    [deleteTagMutation]
  );

  useEffect(() => {
    if (tagsQuery.error) {
      console.error('Failed to load tags:', tagsQuery.error);
    }
  }, [tagsQuery.error]);

  const errorSource =
    tagsQuery.error ??
    createTagMutation.error ??
    deleteTagMutation.error;
  const error = errorSource instanceof Error ? errorSource.message : null;
  const isLoading =
    tagsQuery.isLoading ||
    createTagMutation.isPending ||
    deleteTagMutation.isPending;
  // `isLoading` also covers initial loading and tag creation, so it
  // cannot drive a per-tag indicator. `variables` holds the argument passed to
  // mutateAsync, which identifies the tag whose deletion is in flight.
  const deletingTagId = deleteTagMutation.isPending
    ? deleteTagMutation.variables?.id ?? null
    : null;

  return {
    tags: tagsQuery.data ?? [],
    isLoading,
    deletingTagId,
    error,
    createTag,
    deleteTag,
  };
}
