export interface MediaRepository {
  /** null distinguishes an invalid share slug from an unauthorized media path. */
  getPathAccess(path: string, options: { userId?: string; shareSlug?: string }): Promise<boolean | null>;
}
