import type pg from 'pg';
import {operationReservationKey,type LtiOperationKind} from '../../shared/lti-operation-key';
export {operationReservationKey,type LtiOperationKind} from '../../shared/lti-operation-key';

/** Must run in the mutation transaction, after authorization and before receipt lookup. */
export async function reserveLtiOperation(client: pg.Client, kind: LtiOperationKind, id: string): Promise<boolean> {
  const key = await operationReservationKey(kind, id);
  const inserted = await client.query('INSERT INTO lti_operation_reservations(key) VALUES($1) ON CONFLICT DO NOTHING RETURNING key', [key]);
  // Existing reservations serialize duplicate writers and cleanup, including across owners.
  await client.query('SELECT key FROM lti_operation_reservations WHERE key=$1 FOR UPDATE', [key]);
  return inserted.rowCount === 1;
}

/** Fixed SQL expression for the same namespaced hash; identifiers are application-owned. */
export const reservationExpression = (kind: LtiOperationKind, id = 'id') =>
  `encode(sha256(convert_to('videoq:lti-operation:v1:${kind}:'||${id}::text,'UTF8')),'hex')`;
