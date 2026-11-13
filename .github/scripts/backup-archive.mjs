import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, writeFile,open} from 'node:fs/promises';
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

async function privateFile(file,maxBytes=5*1024**3,text=false) {
  let handle;
  try {
    handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const info=await handle.stat();
    if(!info.isFile()||(info.mode&0o077)||info.uid!==process.getuid()||info.size<=0||info.size>maxBytes)throw new Error();
    const hash=createHash('sha256'),buffer=Buffer.alloc(64*1024),chunks=[];let bytes=0;
    for(;;){
      const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;
      bytes+=bytesRead;if(bytes>maxBytes)throw new Error();
      const part=buffer.subarray(0,bytesRead);hash.update(part);if(text)chunks.push(Buffer.from(part));
    }
    if(bytes!==info.size)throw new Error();
    return {bytes,sha256_base64:hash.digest('base64'),text:text?Buffer.concat(chunks).toString('utf8'):undefined};
  } catch {throw new Error('INVALID_PRIVATE_BACKUP_FILE');}
  finally {await handle?.close();}
}

/** Called only after the exact dump has passed isolated restoration. The private
 * manifest is the commit marker; an orphan dump never implies a complete backup.
 * No credentials, records, counts or storage receipts are printed by this module.
 */
export async function retainVerifiedBackup({directory, inventory, schemas, image, context, expectedDump}, run = execute) {
  if (!context) return false;
  // Revalidate even for programmatic callers. No caller-selected bucket or key.
  backupArchiveContext({VIDEOQ_RETAIN_BACKUP: 'true', MAINTENANCE_STAGE: 'backup',
    MAINTENANCE_RUN_ID: context.runId, CODEBUILD_BUILD_ARN: context.buildArn, CODEBUILD_SOURCE_VERSION: context.sourceVersion});
  const call = async args => {
    const {stdout} = await run('aws', ['s3api', ...args, '--region', region, '--expected-bucket-owner', '257240362763', '--output', 'json', '--no-cli-pager'],
      {timeout: 900000, maxBuffer: 1000000, env: {...process.env, AWS_PAGER: '', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true'}});
    return JSON.parse(stdout);
  };
  const upload = async (file, key, expected) => {
    // This intentionally uses single-object PUT, with an explicit bounded size.
    const checked=await privateFile(file),digest=checked.sha256_base64;
    if(expected&&(expected.bytes!==checked.bytes||expected.sha256_base64!==digest))throw new Error('BACKUP_HANDOFF_INTEGRITY_FAILED');
    const result = await call(['put-object', '--bucket', ARCHIVE_BUCKET, '--key', key, '--body', file,
      '--server-side-encryption', 'AES256', '--checksum-sha256', digest, '--if-none-match', '*']);
    if (!result.VersionId || result.VersionId === 'null' || result.ChecksumSHA256 !== digest || result.ServerSideEncryption !== 'AES256') throw new Error('BACKUP_UPLOAD_NOT_VERIFIED');
    const stored = await call(['head-object', '--bucket', ARCHIVE_BUCKET, '--key', key,
      '--version-id', result.VersionId, '--checksum-mode', 'ENABLED']);
    if (stored.VersionId !== result.VersionId || stored.ChecksumSHA256 !== digest || stored.ContentLength !== checked.bytes || stored.ServerSideEncryption !== 'AES256') throw new Error('BACKUP_READBACK_NOT_VERIFIED');
    return {key, version_id: result.VersionId, bytes: checked.bytes, sha256_base64: digest};
  };
  const prefix = 'verified/' + context.runId + '/';
  const dump = await upload(join(directory, 'database.dump'), prefix + 'database.dump',expectedDump);
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

export const BACKUP_SCHEMAS = Object.freeze(['public', 'drizzle', 'videoq_security', 'chat_memory']);

async function privateHandoffDirectory(directory) {
  if (typeof directory !== 'string' || !directory.startsWith('/') || !/^videoq-backup-handoff-/.test(directory.split('/').at(-1))) throw new Error('INVALID_BACKUP_HANDOFF');
  const info = await lstat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) || info.uid !== process.getuid()) throw new Error('INVALID_BACKUP_HANDOFF');
}

/** The DB child has NO AWS credentials. Publish a private completion marker only
 * after the exact isolated dump has passed restoration and inventory checks. */
export async function stageVerifiedBackup({directory, destination, inventory, schemas, image, context}) {
  if (!context) return false;
  backupArchiveContext({VIDEOQ_RETAIN_BACKUP:'true', MAINTENANCE_STAGE:'backup', MAINTENANCE_RUN_ID:context.runId,
    CODEBUILD_BUILD_ARN:context.buildArn, CODEBUILD_SOURCE_VERSION:context.sourceVersion});
  await privateHandoffDirectory(destination);
  const {readdir} = await import('node:fs/promises');
  if ((await readdir(destination)).length) throw new Error('BACKUP_HANDOFF_NOT_EMPTY');
  // Validate and read the same opened inode; do not lstat then copy by pathname.
  // O_NOFOLLOW also refuses a symlink swapped in before the open itself.
  const source = await open(join(directory,'database.dump'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let target,bytes=0;
  const hash=createHash('sha256');
  try {
    const info=await source.stat();
    if (!info.isFile() || (info.mode & 0o077) || info.uid!==process.getuid() || info.size<=0) throw new Error('INVALID_PRIVATE_BACKUP_FILE');
    target=await open(join(destination,'database.dump'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    const buffer=Buffer.alloc(64*1024);
    for (;;) {
      const {bytesRead}=await source.read(buffer,0,buffer.length,null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0,bytesRead));bytes+=bytesRead;
      for(let offset=0;offset<bytesRead;){const result=await target.write(buffer,offset,bytesRead-offset,null);if(!result.bytesWritten)throw new Error('BACKUP_HANDOFF_WRITE_FAILED');offset+=result.bytesWritten;}
    }
    if(bytes!==info.size)throw new Error('BACKUP_HANDOFF_SOURCE_CHANGED');
    await target.sync();
  } finally {
    try {await target?.close();}finally{await source.close();}
  }
  const metadata = {version:1,status:'restore-verified',context,inventory,schemas,image,
    dump:{bytes,sha256_base64:hash.digest('base64')}};
  await writeFile(join(destination,'verified-backup-input.json'),JSON.stringify(metadata)+'\n',{mode:0o600,flag:'wx'});
  return true;
}

/** Only the AWS parent invokes this, after the DB child has exited successfully.
 * The fixed parent-owned directory and run-bound marker prevent caller-selected
 * output paths or a stale/partial child result from authorizing an upload. */
export async function retainStagedBackup(directory,context,run = execute) {
  await privateHandoffDirectory(directory);
  const {readFile,readdir} = await import('node:fs/promises');
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(['database.dump','verified-backup-input.json'])) throw new Error('INCOMPLETE_BACKUP_HANDOFF');
  let metadata;
  try{metadata=JSON.parse((await privateFile(join(directory,'verified-backup-input.json'),4*1024*1024,true)).text);}
  catch{throw new Error('INVALID_BACKUP_HANDOFF_MARKER');}
  const image = (await readFile(new URL('../operations-tools/Dockerfile',import.meta.url),'utf8')).trim().replace(/^FROM /,'');
  if (metadata.version !== 1 || metadata.status !== 'restore-verified' || JSON.stringify(metadata.context) !== JSON.stringify(context) ||
      JSON.stringify(metadata.schemas) !== JSON.stringify(BACKUP_SCHEMAS) || metadata.image !== image ||
      !metadata.inventory || typeof metadata.inventory !== 'object' || Array.isArray(metadata.inventory) ||
      !Object.keys(metadata.inventory).length || Object.values(metadata.inventory).some(count=>typeof count !== 'string' || !/^(0|[1-9][0-9]*)$/.test(count))) throw new Error('INVALID_BACKUP_HANDOFF_MARKER');
  if(!Number.isSafeInteger(metadata.dump?.bytes)||metadata.dump.bytes<=0||typeof metadata.dump?.sha256_base64!=='string')throw new Error('INVALID_BACKUP_HANDOFF_MARKER');
  return retainVerifiedBackup({directory,inventory:metadata.inventory,schemas:metadata.schemas,image:metadata.image,context,expectedDump:metadata.dump},run);
}
