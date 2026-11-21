import { and, type SQL } from "drizzle-orm";
import type { SceneIndexLogic } from "../application/scene-index-policy";

export const sceneIndexDrizzleLogic: SceneIndexLogic<SQL> = {
  and: (...terms) => and(...terms)!,
};
