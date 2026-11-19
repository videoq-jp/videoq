export type LmsGrant = { id: string; ownerUserId?: string; materialsLease?: { id: string; token: string } };
export type OwnedLmsGrant = LmsGrant & { ownerUserId: string };
export type LmsUploadSnapshot = { resourceId: string; externalId: string; generation: number; videoId: number; fileKey: string; size: number; contentType: string };
export type LmsContentAttempt = { id: string; grant: OwnedLmsGrant; snapshot: LmsUploadSnapshot; fileKey: string };

/** Facts required to reserve an immutable upload for the current LMS generation. */
export interface LmsUploadSource {
  resource: { id: string; kind: string; enabled: boolean; generation: number; fileSize: number | null; contentType: string | null };
  video: { id: number; file: string } | null;
}
