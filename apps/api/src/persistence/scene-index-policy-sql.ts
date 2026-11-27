import { and, type SQL } from "drizzle-orm";
import type { SceneIndexLogic } from "../domain/search/scene-index-policy";

export const sceneIndexDrizzleLogic: SceneIndexLogic<SQL> = {
  and: (...terms) => and(...terms)!,
};
