export type LmsGrant = { id: string; ownerUserId?: string; materialsLease?: { id: string; token: string } };
export type OwnedLmsGrant = LmsGrant & { ownerUserId: string };
export type LmsUploadSnapshot = { resourceId: string; externalId: string; generation: number; videoId: number; fileKey: string; size: number; contentType: string };
export type LmsContentAttempt = { id: string; grant: OwnedLmsGrant; snapshot: LmsUploadSnapshot; fileKey: string };

/** Facts required to reserve an immutable upload for the current LMS generation. */
export interface LmsUploadSource {
  resource: { id: string; kind: string; enabled: boolean; generation: number; fileSize: number | null; contentType: string | null };
  video: { id: number; file: string } | null;
}

export function lmsUploadMaterialAllowed(resource: { kind: string; enabled: boolean }, hasVideo: boolean): boolean {
  return hasVideo && resource.kind === 'video' && resource.enabled;
}
export function currentLmsUploadSource<T extends LmsUploadSource>(data: T | null, generation: number): data is T & { video: NonNullable<T['video']> } {
  return !!data && lmsUploadMaterialAllowed(data.resource, !!data.video) && data.resource.generation === generation;
}
export function lmsUploadActorAllowed(operation: 'content' | 'confirm', ownerUserId: string): boolean {
  return operation !== 'confirm' || !!ownerUserId;
}
export function planLmsUploadSnapshot(data: LmsUploadSource | null, externalId: string, generation: number): LmsUploadSnapshot | null {
  if (!currentLmsUploadSource(data, generation) || data.resource.fileSize === null || !data.resource.contentType) return null;
  return { resourceId: data.resource.id, externalId, generation, videoId: data.video.id,
    fileKey: data.video.file, size: data.resource.fileSize, contentType: data.resource.contentType };
}
