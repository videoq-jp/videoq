import type { TagRepository } from '../../persistence/contracts/tag-repository';
import { TagNameConflictError } from '../../persistence/contracts/tag-repository';
import { conflict } from '../../application/errors';
import {
  normalizeTagName, isValidTagColor, EMPTY_NAME_MESSAGE, INVALID_COLOR_MESSAGE,
} from '../../domain/learning/tag-policy';

function rethrowConflict(error: unknown): never {
  if (error instanceof TagNameConflictError) {
    throw conflict('A tag with this name already exists.');
  }
  throw error;
}

/** Runtime composition and transport error formatting belong to adapters. */
export function createTagService(repository: TagRepository) {
  return {
    listTags: (userId: string, limit: number, offset: number) => repository.listPage(userId, limit, offset),
    getTag: (tagId: number, userId: string) => repository.getDetail(tagId, userId),
    removeTag: (tagId: number, userId: string) => repository.delete(tagId, userId),
    async updateUserTag(tagId: number, userId: string, fields: { name?: string; color?: string }) {
      const name = fields.name === undefined ? undefined : normalizeTagName(fields.name);
      const error = name === null ? EMPTY_NAME_MESSAGE
        : fields.color !== undefined && !isValidTagColor(fields.color) ? INVALID_COLOR_MESSAGE : null;
      // An invalid patch must never write its valid fields. The repository's
      // owned no-op read preserves notFound precedence without signing media.
      if (error) {
        const owned = await repository.update(tagId, userId, {});
        return 'notFound' in owned ? owned : { error };
      }
      return repository.update(tagId, userId, { name: name ?? undefined, color: fields.color }).catch(rethrowConflict);
    },
    async createUserTag(userId: string, rawName: string, color: string) {
      const name = normalizeTagName(rawName);
      if (name === null) return { error: EMPTY_NAME_MESSAGE } as const;
      if (!isValidTagColor(color)) return { error: INVALID_COLOR_MESSAGE } as const;
      return { tag: await repository.create(userId, name, color).catch(rethrowConflict) };
    },
  };
}
