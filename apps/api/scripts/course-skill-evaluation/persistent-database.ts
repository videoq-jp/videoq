/** Private, exclusive local storage. Never opens a remote database. */
import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { retainD1BatchStatements } from '../../test/persistence/d1-fixture';

export async function openPersistentEvaluationDatabase(options: {
  directory: string;
  inputHash: string;
  initialize: (database: D1Database) => Promise<void>;
}) {
  if (!/^[a-f0-9]{64}$/.test(options.inputHash)) throw new Error('INVALID_EVALUATION_INPUT_HASH');
  const directory = resolve(options.directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lockPath = join(directory, 'database.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('EVALUATION_DATABASE_ALREADY_OPEN_OR_UNRESOLVED'); });
  let runtime: Miniflare | undefined;
  const close = async () => {
    try { await runtime?.dispose(); }
    finally { await lock.close(); await unlink(lockPath); }
  };
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const migrationDirectory = fileURLToPath(new URL('../../drizzle-d1/', import.meta.url));
    const names = (await readdir(migrationDirectory)).filter(n => n.endsWith('.sql')).sort();
    const migrations = await Promise.all(names.map(async name => ({ name, sql: await readFile(join(migrationDirectory, name), 'utf8') })));
    const schemaHash = createHash('sha256').update(JSON.stringify(migrations)).digest('hex');
    runtime = new Miniflare({
      ...convertV4MiniflareOptions({ modules: true, script: "export default { fetch() { return new Response('Local evaluation'); } }", compatibilityDate: '2026-08-20', d1Databases: ['DB'] }),
      resourcePersistencePath: join(directory, 'storage'),
    });
    const database = retainD1BatchStatements(await runtime.getD1Database('DB'));
    await database.prepare('CREATE TABLE IF NOT EXISTS evaluation_manifest (id INTEGER PRIMARY KEY CHECK(id=1), input_hash TEXT NOT NULL, schema_hash TEXT NOT NULL, ready INTEGER NOT NULL)').run();
    const prior = await database.prepare('SELECT input_hash, schema_hash, ready FROM evaluation_manifest WHERE id=1').first<{ input_hash: string; schema_hash: string; ready: number }>();
    if (prior) {
      if (prior.input_hash !== options.inputHash || prior.schema_hash !== schemaHash) throw new Error('EVALUATION_DATABASE_INPUTS_CHANGED');
      if (prior.ready !== 1) throw new Error('EVALUATION_DATABASE_INITIALIZATION_INCOMPLETE');
    } else {
      // Record the incomplete state first: a crashed initialization must never
      // silently rerun seed writes over partially initialized publications.
      await database.prepare('INSERT INTO evaluation_manifest VALUES(1,?,?,0)').bind(options.inputHash, schemaHash).run();
      for (const migration of migrations) {
        const statements = migration.sql.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean);
        for (let offset = 0; offset < statements.length; offset += 25) await database.batch(statements.slice(offset, offset + 25).map(sql => database.prepare(sql)));
      }
      await options.initialize(database);
      await database.prepare('UPDATE evaluation_manifest SET ready=1 WHERE id=1').run();
    }
    return { database, resumed: Boolean(prior), dispose: close };
  } catch (error) { await close(); throw error; }
}
