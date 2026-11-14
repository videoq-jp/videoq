/** Current authoritative browser-session state, without refreshing the session.
 * Dates cross the persistence boundary as UTC ISO strings. */
export type UploadSessionUser = {
  id: string;
  banned: boolean | null;
  banExpires: string | null;
};

export interface UploadSessionRepository {
  findUnexpiredUser(token: string): Promise<UploadSessionUser | null>;
}
