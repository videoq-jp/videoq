import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute = promisify(execFile);
export const ARCHIVE_BUCKET = 'videoq-db-archives-prod-257240362763';
const region = 'ap-northeast-1';

export function backupArchiveContext(env = process.env) {
  if (env.VIDEOQ_RETAIN_BACKUP === undefined || env.VIDEOQ_RETAIN_BACKUP === 'false') return null;
  if (env.VIDEOQ_RETAIN_BACKUP !== 'true' || env.MAINTENANCE_STAGE !== 'backup' ||
      !/^[a-f0-9]{32}$/.test(env.MAINTENANCE_RUN_ID || '') ||
      !/^arn:aws:codebuild:ap-northeast-1:257240362763:build\/videoq-db-backup-prod:[a-f0-9-]{36}$/.test(env.CODEBUILD_BUILD_ARN || '') ||
      !env.CODEBUILD_SOURCE_VERSION || env.CODEBUILD_SOURCE_VERSION.length > 1024) {
    throw new Error('INVALID_BACKUP_ARCHIVE_CONTEXT');
  }
  return {runId: env.MAINTENANCE_RUN_ID, buildArn: env.CODEBUILD_BUILD_ARN, sourceVersion: env.CODEBUILD_SOURCE_VERSION};
}

async function checksum(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}

/** Called only after the exact dump has passed isolated restoration. The private
 * manifest is the commit marker; an orphan dump never implies a complete backup.
 * No credentials, records, counts or storage receipts are printed by this module.
 */
export async function retainVerifiedBackup({directory, inventory, schemas, image, context}, run = execute) {
  if (!context) return false;
  // Revalidate even for programmatic callers. No caller-selected bucket or key.
  backupArchiveContext({VIDEOQ_RETAIN_BACKUP: 'true', MAINTENANCE_STAGE: 'backup',
    MAINTENANCE_RUN_ID: context.runId, CODEBUILD_BUILD_ARN: context.buildArn, CODEBUILD_SOURCE_VERSION: context.sourceVersion});
  const call = async args => {
    const {stdout} = await run('aws', ['s3api', ...args, '--region', region, '--expected-bucket-owner', '257240362763', '--output', 'json', '--no-cli-pager'],
      {timeout: 900000, maxBuffer: 1000000, env: {...process.env, AWS_PAGER: '', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true'}});
    return JSON.parse(stdout);
  };
  const upload = async (file, key) => {
    const stat = await lstat(file);
    // This intentionally uses single-object PUT, with an explicit bounded size.
    if (!stat.isFile() || stat.size <= 0 || stat.size > 5 * 1024 ** 3 || (stat.mode & 0o077)) throw new Error('INVALID_PRIVATE_BACKUP_FILE');
    const digest = await checksum(file);
    const result = await call(['put-object', '--bucket', ARCHIVE_BUCKET, '--key', key, '--body', file,
      '--server-side-encryption', 'AES256', '--checksum-sha256', digest, '--if-none-match', '*']);
    if (!result.VersionId || result.VersionId === 'null' || result.ChecksumSHA256 !== digest || result.ServerSideEncryption !== 'AES256') throw new Error('BACKUP_UPLOAD_NOT_VERIFIED');
    const stored = await call(['head-object', '--bucket', ARCHIVE_BUCKET, '--key', key,
      '--version-id', result.VersionId, '--checksum-mode', 'ENABLED']);
    if (stored.VersionId !== result.VersionId || stored.ChecksumSHA256 !== digest || stored.ContentLength !== stat.size || stored.ServerSideEncryption !== 'AES256') throw new Error('BACKUP_READBACK_NOT_VERIFIED');
    return {key, version_id: result.VersionId, bytes: stat.size, sha256_base64: digest};
  };
  const prefix = 'verified/' + context.runId + '/';
  const dump = await upload(join(directory, 'database.dump'), prefix + 'database.dump');
  const manifest = {version: 1, status: 'restored-and-retained', created_at: new Date().toISOString(),
    source: {build_arn: context.buildArn, operator_source_version: context.sourceVersion, snapshot: 'repeatable-read/read-only'},
    schemas, inventory, restore_image: image, dump,
    limitations: ['Logical database contents only; roles, ownership, grants, R2, Vectorize and Neon PITR are not included.',
      'This preservation copy is not a D1 import archive or proof of a completed migration.']};
  const path = join(directory, 'verified-backup.json');
  await writeFile(path, JSON.stringify(manifest) + '\n', {mode: 0o600, flag: 'wx'});
  await upload(path, prefix + 'verified-backup.json');
  return true;
}
