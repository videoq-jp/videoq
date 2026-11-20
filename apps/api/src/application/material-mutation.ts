import { conflict, tooLarge } from './errors';
import type { MaterialCommand, ManagedVideo, ReadableManagedVideo, MaterialTranscriptionMessage } from './material-management';

export function assertMaterialGeneration(actual: number, expected: number): void {
  if (actual !== expected) throw conflict('The Moodle source has changed. Refresh after synchronization.');
}

export function assertMaterialReferences(courseCount: number, onlyCourseId: number, resourceCount: number, expectedCourseId: number): void {
  if (courseCount !== 1 || onlyCourseId !== expectedCourseId || resourceCount !== 1)
    throw conflict('This material is referenced outside this course. Ask the connected account owner to review it.');
}

export function assertMaterialReadable(video: ManagedVideo): asserts video is ReadableManagedVideo {
  if (video.description === null || video.transcript === null) throw tooLarge('This material is too large to edit here.');
}

export function assertMaterialReplayIdentity(actorMatches: boolean, resourceMatches: boolean, requestMatches: boolean): void {
  if (!actorMatches || !resourceMatches || !requestMatches) throw conflict('This operation identifier has already been used.');
}

export function assertMaterialOperationAvailable(available: boolean): void {
  if (!available) throw conflict('This operation is no longer available. Refresh and start a new operation.');
}

export function assertMaterialRevision(actual: string, expected: string): void {
  if (actual !== expected) throw conflict('This material was changed by another operation. Refresh before saving.');
}

type MutationCommand = Exclude<MaterialCommand, { action: 'get' }>;
export type MaterialMutationKind = 'update' | 'index' | 'retry';

/** Call before reading retry jobs or applying backend-specific input limits. */
export function materialMutationKind(input: MutationCommand, status: string): MaterialMutationKind {
  if (input.action === 'update') {
    if (!['completed', 'error'].includes(status)) throw conflict('Wait for processing before editing this material.');
    return 'update';
  }
  if (input.action === 'reindex' || status === 'indexing') {
    if (input.action === 'reindex' && status !== 'completed') throw conflict('Wait for processing before starting a new index.');
    return 'index';
  }
  if (status !== 'error') throw conflict('This material does not need a processing retry.');
  return 'retry';
}

type MaterialJobIntent =
  | { kind: 'index'; payload: { video_id: number; allow_empty?: true } }
  | { kind: 'retry'; message: MaterialTranscriptionMessage };
export type MaterialMutationPlan = {
  next: ReadableManagedVideo;
  transcriptChanged: boolean;
  indexChanged: boolean;
  job?: MaterialJobIntent;
};

/** A retry reuses the decoded original envelope, including its worker identity. */
export function planMaterialMutation(input: MutationCommand, video: ReadableManagedVideo,
  original?: MaterialTranscriptionMessage, retryStatus?: string | null): MaterialMutationPlan {
  const kind = materialMutationKind(input, video.status);
  const next = { ...video };
  let transcriptChanged = false;
  if (input.action === 'update') {
    next.description = input.fields.description ?? video.description;
    next.transcript = input.fields.transcript ?? video.transcript;
    transcriptChanged = input.fields.transcript !== undefined && input.fields.transcript !== video.transcript;
    if (!transcriptChanged) return { next, transcriptChanged, indexChanged: false };
  }
  if (kind !== 'retry') {
    next.status = 'indexing';
    return { next, transcriptChanged, indexChanged: true,
      job: { kind: 'index', payload: { video_id: input.videoId, ...(!next.transcript.trim() ? { allow_empty: true } : {}) } } };
  }
  if (!original || original.payload.video_id !== input.videoId || retryStatus === 'completed')
    throw conflict('Retry synchronization from Moodle for this processing job.');
  next.status = 'pending';
  return { next, transcriptChanged, indexChanged: false, job: { kind: 'retry', message: original } };
}
