export interface FileUploadDependencies<Session, Result> {
  request(): Promise<{ videoId: number; directUrl?: string | null; multipart?: Session | null }>;
  multipart(videoId: number, session: Session): Promise<Result>;
  transfer(url: string): Promise<void>;
  confirm(videoId: number): Promise<Result>;
}

/** A multipart completion owns confirmation; a direct transfer confirms only after success. */
export async function uploadPreparedFile<Session, Result>(deps: FileUploadDependencies<Session, Result>): Promise<Result> {
  const session = await deps.request();
  if (session.multipart) return deps.multipart(session.videoId, session.multipart);
  if (!session.directUrl) throw new Error('Upload URL is missing');
  await deps.transfer(session.directUrl);
  return deps.confirm(session.videoId);
}
