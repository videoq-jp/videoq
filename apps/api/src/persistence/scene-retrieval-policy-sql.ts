import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { SceneVisibilityLogic } from '../domain/search/scene-retrieval';

export const sceneVisibilityDrizzleLogic: SceneVisibilityLogic<SQLWrapper, SQL> = {
  and: (left, right) => sql`(${left} AND ${right})`,
  or: (left, right) => sql`(${left} OR ${right})`,
  before: (expires, now) => sql`${expires} < ${now}`,
};
