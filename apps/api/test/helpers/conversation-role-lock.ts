import pg from 'pg';

/** Optional production role names are cluster-wide, unlike each fixture's DB.
 * Serialize their create/grant/drop lifecycle with other migration fixtures.
 * Hold this connection to the common administrative database until cleanup.
 */
export async function lockConversationTestRoles(databaseUrl: string) {
  const client = new pg.Client({ connectionString: databaseUrl });
  client.on('error', () => {});
  await client.connect();
  try { await client.query('SELECT pg_advisory_lock(996, 43)'); }
  catch (error) { await client.end(); throw error; }
  return async () => {
    try { await client.query('SELECT pg_advisory_unlock(996, 43)'); }
    finally { await client.end(); }
  };
}
