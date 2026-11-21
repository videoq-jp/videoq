import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { UploadRefundLogic } from "../application/video-mutation";

export const videoMutationDrizzleLogic: UploadRefundLogic<SQLWrapper, SQL> = {
  statusIs: (status, expected) => sql`${status}=${expected}`,
  positive: (bytes) => sql`${bytes}>0`,
  and: (left, right) => sql`(${left} AND ${right})`,
};
