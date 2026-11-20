import { createTagService } from '../features/tags/core';
import { createTagRepository } from '../persistence/factory';
import { asApiError } from '../shared/errors';
import type { Bindings } from '../types/bindings';

async function service(env: Bindings) {
  return createTagService(await createTagRepository(env));
}

// Preserve the existing HTTP-facing compatibility entrypoints.
async function transportResult<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw asApiError(error) ?? error; }
}
export async function listTags(env: Bindings, userId: string, limit: number, offset: number) {
  return (await service(env)).listTags(userId, limit, offset);
}
export async function getTag(env: Bindings, tagId: number, userId: string) {
  return (await service(env)).getTag(tagId, userId);
}
export async function removeTag(env: Bindings, tagId: number, userId: string) {
  return (await service(env)).removeTag(tagId, userId);
}
export function createUserTag(env: Bindings, userId: string, rawName: string, color: string) {
  return transportResult(async () => (await service(env)).createUserTag(userId, rawName, color));
}
export function updateUserTag(env: Bindings, tagId: number, userId: string, fields: { name?: string; color?: string }) {
  return transportResult(async () => (await service(env)).updateUserTag(tagId, userId, fields));
}
