import type { Bindings } from "../types/bindings";
import { createTagRepository } from "../persistence/factory";
export { INVALID_COLOR_MESSAGE,EMPTY_NAME_MESSAGE,normalizeTagName,isValidTagColor } from "../shared/tag-policy";
export type {TagListItem,TagDetail} from "../persistence/contracts/tag-repository";
export async function listTagsPage(env: Bindings,userId: string,limit: number,offset: number) {
 return (await createTagRepository(env)).listPage(userId,limit,offset);
}
export async function getTagDetail(env: Bindings,tagId: number,userId: string) {
 return (await createTagRepository(env)).getDetail(tagId,userId);
}
export async function updateTag(env: Bindings,tagId: number,userId: string,fields: {name?: string;color?: string}) {
 return (await createTagRepository(env)).update(tagId,userId,fields);
}
export async function createTag(env: Bindings,userId: string,name: string,color: string) {
 return (await createTagRepository(env)).create(userId,name,color);
}
export async function deleteTag(env: Bindings,tagId: number,userId: string) {
 return (await createTagRepository(env)).delete(tagId,userId);
}
