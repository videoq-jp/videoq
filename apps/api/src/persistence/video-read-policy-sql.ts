import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

export const videoReadDrizzleLogic = {
  statusIs: (status: SQLWrapper, expected: 'uploading') => sql`${status}=${expected}`,
  and: (left: SQL, right: SQL) => sql`(${left} AND ${right})`,
};
