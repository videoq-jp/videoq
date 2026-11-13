import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { execFile as callbackExec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { backupArchiveContext, backupD1ExportRequested, stageVerifiedBackup, BACKUP_SCHEMAS } from './backup-archive.mjs';
import {exportRestoredBackup} from './backup-d1-run.mjs';
const require = createRequire(new URL('../operations-tools/package.json', import.meta.url));
const { Client } = require('pg');
const exec = promisify(callbackExec);
const IMAGE = (await fs.readFile(new URL('../operations-tools/Dockerfile', import.meta.url), 'utf8')).trim().replace(/^FROM /, '');
if (!/^pgvector\/pgvector:pg17@sha256:[a-f0-9]{64}$/.test(IMAGE)) throw new Error('Review the restore image before changing PostgreSQL versions');
const source = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15_000,
  statement_timeout: 300_000, application_name: 'videoq-restore-test-readonly' });
const name = 'videoq-restore-' + randomBytes(12).toString('hex');
const password = randomBytes(32).toString('hex');
// libpq does not expand a URI stored in the PGDATABASE environment variable.
// Pass individual connection parameters so credentials never enter argv/logs.
const sourceUrl = new URL(process.env.DATABASE_URL);
if (!['postgres:', 'postgresql:'].includes(sourceUrl.protocol)) throw new Error('Expected PostgreSQL');
const dumpEnvironment = { ...process.env,
  PGHOST: process.platform === 'darwin' && ['localhost', '127.0.0.1', '[::1]'].includes(sourceUrl.hostname)
    ? 'host.docker.internal' : sourceUrl.hostname, PGPORT: sourceUrl.port || '5432',
  PGDATABASE: decodeURIComponent(sourceUrl.pathname.slice(1)),
  PGUSER: decodeURIComponent(sourceUrl.username), PGPASSWORD: decodeURIComponent(sourceUrl.password),
  PGSSLMODE: sourceUrl.searchParams.get('sslmode') || 'prefer',
  PGCHANNELBINDING: sourceUrl.searchParams.get('channel_binding') || 'prefer',
  PGSSLROOTCERT: '/backup/ca.crt',
  PGOPTIONS: '-c default_transaction_read_only=on',
};
let temporary, restored, started = false, stage = 'database-connect';
const docker = (args, options = {}) => exec('docker', args, { maxBuffer: 4_000_000, timeout: 900_000, ...options });
const identifier = value => '"' + value.replaceAll('"', '""') + '"';
async function inventory(client) {
  const { rows } = await client.query(`SELECT schemaname, tablename FROM pg_tables
    WHERE schemaname = ANY($1::text[]) ORDER BY schemaname, tablename`, [BACKUP_SCHEMAS]);
  const result = {};
  for (const row of rows) {
    const table = identifier(row.schemaname) + '.' + identifier(row.tablename);
    result[table] = (await client.query('SELECT count(*) AS count FROM ' + table)).rows[0].count;
  }
  return result;
}
let report = { status: 'error', summary: 'バックアップの復元テストを完了できませんでした。', details: [] };
try {
  const archiveContext = backupArchiveContext();
  const exportD1 = backupD1ExportRequested();
  await source.connect();
  const version = Number((await source.query('SHOW server_version_num')).rows[0].server_version_num);
  if (Math.floor(version / 10000) !== 17) throw new Error('Review matching PostgreSQL client before restoring');
  await docker(['pull', IMAGE]);
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'videoq-restore-'));
  await fs.chmod(temporary, 0o700);
  // Copy the host trust bundle into the shared private directory so Docker
  // mounts a real file on both Linux runners and macOS developer machines.
  await fs.copyFile(process.platform === 'darwin' ? '/etc/ssl/cert.pem' : '/etc/ssl/certs/ca-certificates.crt', path.join(temporary, 'ca.crt'));
  await fs.chmod(path.join(temporary, 'ca.crt'), 0o600);
  stage = 'read-only-snapshot';
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await source.query("SET LOCAL idle_in_transaction_session_timeout = '20min'");
  const snapshot = (await source.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
  if (!/^[0-9A-F-]+$/.test(snapshot)) throw new Error('Invalid snapshot');
  const expected = await inventory(source);
  if (Object.keys(expected).length < 3) throw new Error('Incomplete source inventory');
  stage = 'logical-backup';
  await docker(['run', '--rm', ...(process.platform === 'darwin' ? [] : ['--network', 'host']), '--user', process.getuid() + ':' + process.getgid(),
    '-e', 'PGDATABASE', '-e', 'PGOPTIONS',
    '-e', 'PGHOST', '-e', 'PGPORT', '-e', 'PGUSER', '-e', 'PGPASSWORD', '-e', 'PGSSLMODE', '-e', 'PGCHANNELBINDING', '-e', 'PGSSLROOTCERT',
    '-v', temporary + ':/backup', IMAGE, 'pg_dump', '--format=custom', '--no-owner', '--no-acl', '--no-comments',
    ...BACKUP_SCHEMAS.map(schema => '--schema=' + schema), '--snapshot=' + snapshot, '--file=/backup/database.dump'], {
    env: dumpEnvironment,
  });
  await source.query('COMMIT');
  await fs.chmod(path.join(temporary, 'database.dump'), 0o600);
  stage = 'isolated-restore';
  await docker(['run', '--detach', '--name', name, '--label', 'videoq.operation=restore-test',
    '-e', 'POSTGRES_PASSWORD', '-p', '127.0.0.1::5432', '-v', temporary + ':/backup:ro', IMAGE],
  { env: { ...process.env, POSTGRES_PASSWORD: password } });
  started = true;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await docker(['exec', name, 'pg_isready', '-U', 'postgres']); break; }
    catch { if (attempt === 59) throw new Error('Restore server unavailable'); await delay(1000); }
  }
  await docker(['exec', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE EXTENSION vector;']);
  const { stdout: toc } = await docker(['exec', name, 'pg_restore', '--list', '/backup/database.dump']);
  // The default public schema already exists and hosts the vector extension.
  const filtered = toc.split('\n').filter(line => !/^\d+;\s+\d+\s+\d+\s+SCHEMA - public\s/.test(line)).join('\n');
  await fs.writeFile(path.join(temporary, 'restore.list'), filtered, { mode: 0o600 });
  await docker(['exec', name, 'pg_restore', '--exit-on-error', '--no-owner', '--no-acl',
    '--use-list=/backup/restore.list', '-U', 'postgres', '--dbname=postgres', '/backup/database.dump']);
  const { stdout: ports } = await docker(['port', name, '5432/tcp']);
  const port = /^127\.0\.0\.1:(\d+)\s*$/.exec(ports)?.[1];
  if (!port) throw new Error('Restore database is not bound exclusively to loopback');
  restored = new Client({ host: '127.0.0.1', port: Number(port), user: 'postgres', database: 'postgres', password,
    connectionTimeoutMillis: 15_000, statement_timeout: 300_000 });
  await restored.connect();
  stage = 'row-count-and-constraint-verification';
  const actual = await inventory(restored);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Restored counts differ from the exported snapshot');
  const invalid = await restored.query(`SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = ANY($1::text[]) AND NOT c.convalidated`, [BACKUP_SCHEMAS]);
  if (Number(invalid.rows[0].count)) throw new Error('Unvalidated restored constraints');
  stage = 'restored-backup-d1-export';
  const restoredUrl=new URL(`postgresql://postgres@127.0.0.1:${port}/postgres`);restoredUrl.password=password;
  const d1Export=exportD1?await exportRestoredBackup({databaseUrl:restoredUrl.toString(),directory:temporary}):undefined;
  if(exportD1&&!d1Export)throw new Error('D1 backup export was not verified');
  stage = 'verified-backup-handoff';
  const staged = await stageVerifiedBackup({directory: temporary, destination: process.env.VIDEOQ_BACKUP_HANDOFF, inventory: expected,
    schemas: BACKUP_SCHEMAS, image: IMAGE, context: archiveContext,d1Export});
  report = { status: 'ok', backup_retention: staged ? 'staged' : 'disabled', d1_archive: exportD1?'staged':'not_requested', summary: `${Object.keys(expected).length}テーブルの論理バックアップを隔離DBへ復元し、全テーブルの件数と制約を確認しました。`,
    details: ['- 本番DBへの書き込み、バックアップファイルやレコード内容の公開は行っていません。',
      '- この検査はPostgreSQLの論理復元を対象とし、NeonのPITRやR2の復元は対象に含みません。',
      staged ? '- 復元検証済みdumpを親AWSジョブへ一時受け渡ししました。S3への永続保存は親ジョブの結果で確認してください。' : '- 永続保存は無効です。検証用dumpは終了時に削除され、保全コピーは残りません。'] };
} catch (error) {
  // This exact public fixture URL contains no production data or credentials.
  if (process.env.DATABASE_URL === 'postgresql://postgres:fixture-only@127.0.0.1:54320/postgres') {
    console.error(error.stderr || error.message);
  }
  report.details = ['- 失敗した段階: `' + stage + '`。DB接続情報・レコード・バックアップは出力していません。'];
} finally {
  await restored?.end().catch(() => {});
  await source.query('ROLLBACK').catch(() => {});
  await source.end().catch(() => {});
  if (started) {
    try { await docker(['rm', '--force', '--volumes', name]); }
    catch { report.status = 'error'; report.details.push('- 隔離コンテナの削除を確認できませんでした。'); }
  }
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  await fs.writeFile('operations-report.json', JSON.stringify(report));
}
