/** PostgreSQL-only rehearsal coordination. A snapshot ID is never arbitrary SQL. */
export function validateReadSnapshot(snapshot: string): void {
  if (typeof snapshot !== 'string' || snapshot.length > 128 || !/^[0-9A-F]+-[0-9A-F]+-[0-9]+$/.test(snapshot)) {
    throw new Error('Invalid PostgreSQL read snapshot.');
  }
}

export async function importReadSnapshot(client: {query(sql: string): Promise<unknown>}, snapshot: string): Promise<void> {
  validateReadSnapshot(snapshot);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    // SET TRANSACTION SNAPSHOT does not accept a bind parameter. The validated
    // server-generated identifier contains no quotes or SQL metacharacters.
    await client.query(`SET TRANSACTION SNAPSHOT '${snapshot}'`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
