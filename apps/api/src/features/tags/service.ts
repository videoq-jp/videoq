import {
  createTag,
  updateTag,
  normalizeTagName,
  isValidTagColor,
  EMPTY_NAME_MESSAGE,
  INVALID_COLOR_MESSAGE,
} from "../../repositories/tag-repository";
import { TagNameConflictError } from "../../persistence/contracts/tag-repository";
import { apiConflict } from "../../shared/errors";
import type { Bindings } from "../../types/bindings";

export {
  listTagsPage as listTags,
  getTagDetail as getTag,
  deleteTag as removeTag,
} from "../../repositories/tag-repository";

function handleTagNameConflict(error: unknown): never {
  if (error instanceof TagNameConflictError) {
    throw apiConflict("A tag with this name already exists.");
  }
  throw error;
}

export function updateUserTag(...args: Parameters<typeof updateTag>) {
  return updateTag(...args).catch(handleTagNameConflict);
}

export async function createUserTag(
  env: Bindings,
  userId: string,
  rawName: string,
  color: string,
) {
  const name = normalizeTagName(rawName);
  if (name === null) return { error: EMPTY_NAME_MESSAGE } as const;
  if (!isValidTagColor(color)) return { error: INVALID_COLOR_MESSAGE } as const;
  const tag = await createTag(env, userId, name, color).catch(handleTagNameConflict);
  return { tag } as const;
}
