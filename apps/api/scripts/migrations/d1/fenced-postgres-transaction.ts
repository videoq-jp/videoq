import pg from 'pg';
import {
  inspectPostgresLoginFence,
  postgresLoginFencePlanSchema,
  type PostgresLoginFencePlan,
} from './postgres-login-fence';

/** Own a dedicated administration connection and one transaction. This is for
 * trusted, fixed operator code, not an arbitrary-SQL execution boundary.
 * The AWS global maintenance lock and upstream stop must also remain held. */
export async function withPostgresLoginFenceTransaction<T>(options: {
  connectionString: string;
  plan: PostgresLoginFencePlan;
  upstreamStopped: boolean;
  operation: (client: pg.Client) => Promise<T>;
}): Promise<T> {
  const plan = postgresLoginFencePlanSchema.parse(options.plan);
  if (!options.upstreamStopped) throw new Error('Externally stopped upstream required for fenced transaction.');
  const url = new URL(options.connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.password
    || url.hostname.replace(/^\[|\]$/g, '') !== plan.target.host
    || decodeURIComponent(url.pathname.slice(1)) !== plan.target.databaseName
    || url.hash || url.searchParams.has('options')
    || [...options.connectionString].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    || plan.target.purpose === 'production' && (url.searchParams.getAll('sslmode').length !== 1
      || url.searchParams.get('sslmode') !== 'verify-full' || !['', '5432'].includes(url.port))) {
    throw new Error('Fenced transaction connection differs from the fixed target.');
  }
  const client = new pg.Client({
    connectionString: options.connectionString,
    application_name: 'videoq-fenced-recovery',
    options: '-c search_path=pg_catalog',
    connectionTimeoutMillis: 10000,
    statement_timeout: 60000,
    query_timeout: 65000,
  });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SET LOCAL lock_timeout='5s'");
    const locked = (await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtext($1),hashtext($2)) AS locked',
      ['videoq-login-fence', plan.target.rolePrefix],
    )).rows[0].locked;
    if (!locked) throw new Error('Another fenced operation holds the PostgreSQL fence lock.');
    const before = await inspectPostgresLoginFence(client, plan);
    if (before.state !== 'fenced') throw new Error('Verified PostgreSQL login fence is required.');
    const transaction = (await client.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid;
    const result = await options.operation(client);
    const after = (await client.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid;
    if (after !== transaction) throw new Error('Fenced operation changed its transaction boundary; keep upstream stopped.');
    if ((await inspectPostgresLoginFence(client, plan)).state !== 'fenced') {
      throw new Error('PostgreSQL login fence changed; keep upstream stopped.');
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}
