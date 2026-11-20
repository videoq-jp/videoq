import { createMediaService, createMediaRedirectService } from '../features/media/core';
import { createMediaRepository } from '../persistence/factory';
import { isS3Storage, resolveFileUrl } from './media';
import type { Bindings } from '../types/bindings';

export async function authorizeMediaPath(env: Bindings, path: string, opts: { userId?: string; shareSlug?: string }) {
  return createMediaService(await createMediaRepository(env)).authorizeMediaPath(path, opts);
}
export async function fallbackRedirectUrl(env: Bindings, path: string): Promise<string | null> {
  return createMediaRedirectService({
    externalStorage: isS3Storage(env),
    resolveFileUrl: path => resolveFileUrl(env, path),
  }).fallbackRedirectUrl(path);
}
