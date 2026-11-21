import { sql, type SQL } from "drizzle-orm";
import type { ResourceErrorChoice } from "../application/resource-mutation";

export const resourceDrizzleErrorChoice: ResourceErrorChoice<SQL, SQL> = {
  code: (code) => sql`${code}`,
  when: (condition, yes, no) =>
    sql`CASE WHEN ${condition} THEN ${yes} ELSE ${no} END`,
};
