import { sql, type SQLWrapper } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { ltiOperationReservations } from "../../db/schema";
import type pg from "pg";
import {
  operationReservationKey,
  type LtiOperationKind,
} from "../../shared/lti-operation-key";
export {
  operationReservationKey,
  type LtiOperationKind,
} from "../../shared/lti-operation-key";

/** Must run in the mutation transaction, after authorization and before receipt lookup. */
export async function reserveLtiOperation(
  client: pg.Client,
  kind: LtiOperationKind,
  id: string,
): Promise<boolean> {
  const key = await operationReservationKey(kind, id);
  const db = drizzle(client);
  const inserted = await db
    .insert(ltiOperationReservations)
    .values({ key })
    .onConflictDoNothing()
    .returning({ key: ltiOperationReservations.key });
  // Existing reservations serialize duplicate writers and cleanup, including across owners.
  await db
    .select({ key: ltiOperationReservations.key })
    .from(ltiOperationReservations)
    .where(eq(ltiOperationReservations.key, key))
    .for("update");
  return inserted.length === 1;
}

export const reservationKeySql = (kind: LtiOperationKind, id: SQLWrapper) =>
  sql<string>`encode(sha256(convert_to(${`videoq:lti-operation:v1:${kind}:`}||${id}::text,'UTF8')),'hex')`;
