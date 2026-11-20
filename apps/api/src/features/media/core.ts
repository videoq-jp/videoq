import type { MediaRepository } from '../../persistence/contracts/media-repository';

export interface MediaDependencies {
  externalStorage: boolean;
  resolveFileUrl(path: string): Promise<string | null>;
}

export function createMediaService(repository: MediaRepository) {
  return {
    async authorizeMediaPath(path: string, opts: { userId?: string; shareSlug?: string }): Promise<
      { ok: true; objectKey: string } | { notFound: true } | { invalidShare: true }
    > {
      const access = await repository.getPathAccess(path, opts);
      if (access === null) return { invalidShare: true };
      if (!access) return { notFound: true };
      return { ok: true, objectKey: `media/${path}` };
    },
  };
}

export function createMediaRedirectService(deps: MediaDependencies) {
  return {
    async fallbackRedirectUrl(path: string): Promise<string | null> {
      if (!deps.externalStorage) return null;
      const url = await deps.resolveFileUrl(path);
      return url && !url.startsWith('/') ? url : null;
    },
  };
}
