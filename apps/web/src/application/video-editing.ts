/** Existing transcripts remain editable while processing; completed videos may
 * also receive their first transcript or restore one that was cleared. */
export function canEditVideoTranscript(video: { transcript?: string | null; status: string }): boolean {
  return !!video.transcript || video.status === 'completed';
}

export type EditableVideo = {
  title: string; description?: string | null; tags?: readonly { id: number }[];
};
export type VideoEdits = { title: string; description: string; tagIds: readonly number[] };
export type VideoEditRefresh<Video> = {
  metadataChanged: boolean; tagsChanged: boolean; updatedVideo?: Video;
};
export interface VideoEditingDependencies<Video> {
  updateMetadata(input: { id: number; title?: string; description?: string }): Promise<Video>;
  addTags(input: { videoId: number; tagIds: number[] }): Promise<unknown>;
  removeTag(input: { videoId: number; tagId: number }): Promise<unknown>;
  refresh(videoId: number, result: VideoEditRefresh<Video>): Promise<void>;
}

/** Persist only changed fields; refresh persisted state even after partial writes.
 * Refresh and transport details are supplied by the UI adapter. */
export async function saveVideoEdits<Video>(
  videoId: number | null, video: EditableVideo | null, edits: VideoEdits,
  deps: VideoEditingDependencies<Video>,
): Promise<void> {
  if (!videoId || !video) return;
  const currentTagIds = video.tags?.map(tag => tag.id) || [];
  const tagsToAdd = edits.tagIds.filter(id => !currentTagIds.includes(id));
  const tagsToRemove = currentTagIds.filter(id => !edits.tagIds.includes(id));
  const metadata: { title?: string; description?: string } = {};
  if (edits.title !== video.title) metadata.title = edits.title;
  if (edits.description !== (video.description ?? '')) metadata.description = edits.description;
  const metadataChanged = Object.keys(metadata).length > 0;
  if (!metadataChanged && !tagsToAdd.length && !tagsToRemove.length) return;
  let tagsChanged = false;
  let updatedVideo: Video | undefined;
  try {
    if (metadataChanged) updatedVideo = await deps.updateMetadata({ id: videoId, ...metadata });
    if (tagsToAdd.length > 0) {
      tagsChanged = true;
      await deps.addTags({ videoId, tagIds: tagsToAdd });
    }
    tagsChanged ||= tagsToRemove.length > 0;
    const removals = await Promise.allSettled(tagsToRemove.map(tagId => deps.removeTag({ videoId, tagId })));
    const failed = removals.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  } finally {
    await deps.refresh(videoId, { metadataChanged, tagsChanged, updatedVideo });
  }
}
