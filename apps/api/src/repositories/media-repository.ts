import type { Bindings } from "../types/bindings";
import { createMediaRepository } from "../persistence/factory";
export { isSafeMediaPath } from "../shared/media-path";

export async function getMediaPathAccess(env: Bindings,path: string,options: {userId?: string;shareSlug?: string}) {
 return (await createMediaRepository(env)).getPathAccess(path,options);
}
