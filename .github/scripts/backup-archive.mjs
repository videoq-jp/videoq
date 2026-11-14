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

export function backupD1ExportRequested(env=process.env) {
  if(env.VIDEOQ_EXPORT_D1_FROM_BACKUP===undefined||env.VIDEOQ_EXPORT_D1_FROM_BACKUP==='false')return false;
  if(env.VIDEOQ_EXPORT_D1_FROM_BACKUP!=='true'||!backupArchiveContext(env))throw new Error('INVALID_D1_BACKUP_EXPORT_CONTEXT');
  return true;
}

function validD1Proof(proof) {
  return proof?.version===3&&Number.isSafeInteger(proof.tables)&&proof.tables>0&&typeof proof.rows==='string'&&
    /^(0|[1-9][0-9]*)$/.test(proof.rows)&&/^[0-9a-f]{64}$/.test(proof.archive_sha256)&&
    Number.isSafeInteger(proof.file_bytes)&&proof.file_bytes>0&&/^[A-Za-z0-9+/]{43}=$/.test(proof.file_sha256_base64);
}

function sameFile(expected,actual) {return expected?.bytes===actual.bytes&&expected?.sha256_base64===actual.sha256_base64;}

async function privateFile(file,maxBytes=5*1024**3,text=false) {
  let handle;
  try {
    // Read existing files only; keep a private mode explicit for numeric flags.
    handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
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
export async function retainVerifiedBackup({directory, inventory, schemas, image, context, expectedDump,d1Export}, run = execute) {
  if (!context) return false;
  // Revalidate even for programmatic callers. No caller-selected bucket or key.
  backupArchiveContext({VIDEOQ_RETAIN_BACKUP: 'true', MAINTENANCE_STAGE: 'backup',
    MAINTENANCE_RUN_ID: context.runId, CODEBUILD_BUILD_ARN: context.buildArn, CODEBUILD_SOURCE_VERSION: context.sourceVersion});
  // Check the complete artifact set before any upload, then recheck immediately
  // before each PUT. Failed later uploads leave no completion manifest.
  if(d1Export){
    if(!validD1Proof(d1Export)||d1Export.file_bytes!==d1Export.bytes||d1Export.file_sha256_base64!==d1Export.sha256_base64||
      !sameFile(d1Export,await privateFile(join(directory,'d1-source.videoq-export.ndjson'))))throw new Error('BACKUP_HANDOFF_INTEGRITY_FAILED');
    if(expectedDump&&!sameFile(expectedDump,await privateFile(join(directory,'database.dump'))))throw new Error('BACKUP_HANDOFF_INTEGRITY_FAILED');
  }
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
  const d1Archive=d1Export?await upload(join(directory,'d1-source.videoq-export.ndjson'),prefix+'d1-source.videoq-export.ndjson',d1Export):undefined;
  const manifest = {version: d1Export?2:1, status: 'restored-and-retained', created_at: new Date().toISOString(),
    source: {build_arn: context.buildArn, operator_source_version: context.sourceVersion, snapshot: 'repeatable-read/read-only'},
    schemas, inventory, restore_image: image, dump,
    ...(d1Export?{d1_export:{format_version:3,archive_sha256:d1Export.archive_sha256,tables:d1Export.tables,rows:d1Export.rows,
      source:'isolated restored database from this dump',artifact:d1Archive},execution_complete:false}:{}),
    limitations: ['Logical database contents only; roles, ownership, grants, R2, Vectorize and Neon PITR are not included.',
      d1Export?'The dump is a PostgreSQL preservation copy; the separate D1 input still requires import and cutover validation.':'This preservation copy is not a D1 import archive or proof of a completed migration.']};
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
export async function stageVerifiedBackup({directory, destination, inventory, schemas, image, context,d1Export}) {
  if (!context) return false;
  backupArchiveContext({VIDEOQ_RETAIN_BACKUP:'true', MAINTENANCE_STAGE:'backup', MAINTENANCE_RUN_ID:context.runId,
    CODEBUILD_BUILD_ARN:context.buildArn, CODEBUILD_SOURCE_VERSION:context.sourceVersion});
  await privateHandoffDirectory(destination);
  const {readdir} = await import('node:fs/promises');
  if ((await readdir(destination)).length) throw new Error('BACKUP_HANDOFF_NOT_EMPTY');
  if(d1Export&&!validD1Proof(d1Export))throw new Error('D1_BACKUP_EXPORT_NOT_VERIFIED');
  const dump=await copyPrivateFile(join(directory,'database.dump'),join(destination,'database.dump'));
  const d1=d1Export?{...d1Export,...await copyPrivateFile(join(directory,'d1-source.videoq-export.ndjson'),join(destination,'d1-source.videoq-export.ndjson'))}:undefined;
  if(d1&&(d1.bytes!==d1.file_bytes||d1.sha256_base64!==d1.file_sha256_base64))throw new Error('D1_BACKUP_EXPORT_CHANGED');
  const metadata = {version:d1Export?2:1,status:'restore-verified',context,inventory,schemas,image,dump,...(d1?{d1_export:d1}:{})};
  await writeFile(join(destination,'verified-backup-input.json'),JSON.stringify(metadata)+'\n',{mode:0o600,flag:'wx'});
  return true;
}

async function copyPrivateFile(from,to) {
  // Validate and read the same opened inode; do not lstat then copy by pathname.
  // O_NOFOLLOW also refuses a symlink swapped in before the open itself.
  const source = await open(from,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let target,bytes=0;
  const hash=createHash('sha256');
  try {
    const info=await source.stat();
    if (!info.isFile() || (info.mode & 0o077) || info.uid!==process.getuid() || info.size<=0) throw new Error('INVALID_PRIVATE_BACKUP_FILE');
    target=await open(to,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
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
  return {bytes,sha256_base64:hash.digest('base64')};
}

/** Only the AWS parent invokes this, after the DB child has exited successfully.
 * The fixed parent-owned directory and run-bound marker prevent caller-selected
 * output paths or a stale/partial child result from authorizing an upload. */
export async function retainStagedBackup(directory,context,run = execute,{requireD1Export=false}={}) {
  await privateHandoffDirectory(directory);
  const {readFile,readdir} = await import('node:fs/promises');
  const expectedFiles=['database.dump','verified-backup-input.json',...(requireD1Export?['d1-source.videoq-export.ndjson']:[])].sort();
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(expectedFiles)) throw new Error('INCOMPLETE_BACKUP_HANDOFF');
  let metadata;
  try{metadata=JSON.parse((await privateFile(join(directory,'verified-backup-input.json'),4*1024*1024,true)).text);}
  catch{throw new Error('INVALID_BACKUP_HANDOFF_MARKER');}
  const image = (await readFile(new URL('../operations-tools/Dockerfile',import.meta.url),'utf8')).trim().replace(/^FROM /,'');
  if (metadata.version !== (requireD1Export?2:1) || Boolean(metadata.d1_export)!==requireD1Export || metadata.status !== 'restore-verified' || JSON.stringify(metadata.context) !== JSON.stringify(context) ||
      JSON.stringify(metadata.schemas) !== JSON.stringify(BACKUP_SCHEMAS) || metadata.image !== image ||
      !metadata.inventory || typeof metadata.inventory !== 'object' || Array.isArray(metadata.inventory) ||
      !Object.keys(metadata.inventory).length || Object.values(metadata.inventory).some(count=>typeof count !== 'string' || !/^(0|[1-9][0-9]*)$/.test(count))) throw new Error('INVALID_BACKUP_HANDOFF_MARKER');
  if(!Number.isSafeInteger(metadata.dump?.bytes)||metadata.dump.bytes<=0||typeof metadata.dump?.sha256_base64!=='string')throw new Error('INVALID_BACKUP_HANDOFF_MARKER');
  return retainVerifiedBackup({directory,inventory:metadata.inventory,schemas:metadata.schemas,image:metadata.image,context,expectedDump:metadata.dump,d1Export:metadata.d1_export},run);
}

// Shared descriptor-based inspection for the private, version-pinned downloader.
export {privateFile as inspectPrivateBackupFile};

// Return fixed categories only. PostgreSQL stderr may contain COPY rows, SQL and
// secrets: never include any matched text or the original error in the result.
export const RESTORE_FAILURE_CATEGORIES = Object.freeze([
  ['toc-read', /could not open (TOC|toc) file/i],
  ['input-read', /could not (open|read from) input file/i],
  ['archive-format', /unsupported version .*file header|not .*valid archive|unrecognized data block|could not (uncompress|decompress)/i],
  ['docker-exec', /OCI runtime exec failed|container .* is not running|no such container/i],
  ['missing-object', /ERROR:\s+object [^\n]* does not exist/i],
  ['syntax-error', /ERROR:\s+syntax error/i],
  ['invalid-value', /ERROR:\s+(invalid|out of range)/i],
  ['object-state', /ERROR:[^\n]*(cannot|must|not yet)/i],
  ['output-limit', /maxBuffer length exceeded/],
  ['missing-role', /ERROR:\s+role [^\n]* does not exist/i],
  ['missing-extension', /ERROR:\s+extension [^\n]* (is not available|does not exist)/i],
  ['missing-function', /ERROR:\s+function [^\n]* does not exist/i],
  ['missing-type', /ERROR:\s+type [^\n]* does not exist/i],
  ['missing-schema', /ERROR:\s+schema [^\n]* does not exist/i],
  ['missing-relation', /ERROR:\s+relation [^\n]* does not exist/i],
  ['missing-collation', /ERROR:\s+collation [^\n]* does not exist/i],
  ['missing-access-method', /ERROR:\s+(operator class|access method) [^\n]* does not exist/i],
  ['duplicate-object', /ERROR:[^\n]* already exists/i],
  ['permission-denied', /permission denied/i],
  ['foreign-key', /ERROR:[^\n]* violates foreign key constraint/i],
  ['unique-key', /ERROR:[^\n]* duplicate key value violates unique constraint/i],
  ['unsupported-setting', /ERROR:\s+unrecognized configuration parameter/i],
  ['disk-full', /no space left on device/i],
  ['out-of-memory', /out of memory|could not (allocate|resize shared memory)/i],
  ['backend-other', /could not execute query/i],
]);
export const RESTORE_SQLSTATE_CATEGORIES = Object.freeze({
 '42704':'missing-object','42P01':'missing-relation','42883':'missing-function',
 '3F000':'missing-schema','42501':'permission-denied','23505':'unique-key',
 '23503':'foreign-key','53100':'disk-full','53200':'out-of-memory',
 '42601':'syntax-error','22023':'invalid-value','22003':'invalid-value',
 '22P02':'invalid-value','55000':'object-state','0A000':'object-state',
 'XX000':'backend-other',
});
export function restoreArchiveFailureStage(error, serverLog='') {
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'restore-archive-apply-output-limit';
  const sqlstate = typeof serverLog === 'string' ? [...serverLog.slice(0,4_000_000).matchAll(/(?:ERROR|FATAL|PANIC):\s+([A-Z0-9]{5}):/g)].at(-1)?.[1] : null;
  if (sqlstate && RESTORE_SQLSTATE_CATEGORIES[sqlstate]) return 'restore-archive-apply-' + RESTORE_SQLSTATE_CATEGORIES[sqlstate];
  const stderr = typeof error?.stderr === 'string' ? error.stderr.slice(0,4_000_000)
    : Buffer.isBuffer(error?.stderr) ? error.stderr.subarray(0,4_000_000).toString('utf8') : '';
  const category = RESTORE_FAILURE_CATEGORIES.find(([,pattern]) => pattern.test(stderr))?.[0];
  return 'restore-archive-apply' + (category ? '-' + category : '');
}

const RESTORE_SETTINGS = Object.freeze(['statement_timeout','lock_timeout','idle_in_transaction_session_timeout','transaction_timeout','client_encoding','standard_conforming_strings','check_function_bodies','xmloption','client_min_messages','row_security','default_tablespace','default_table_access_method','search_path']);
export const RESTORE_OPERATIONS = Object.freeze([...RESTORE_SETTINGS.map(name=>'SET_'+name.toUpperCase()),'COPY','SET','SEQUENCE_SETVAL','SELECT','CREATE_COLLATION','CREATE_INDEX','CREATE_FUNCTION','CREATE_TABLE','CREATE_VIEW','CREATE_TYPE','CREATE_SCHEMA','CREATE_TRIGGER','ALTER_TABLE','ALTER_FUNCTION','OTHER']);
export function restoreArchiveFailureDetails(error, serverLog='') {
 const log=typeof serverLog==='string'?serverLog.slice(0,4_000_000):'';
 const candidate=[...log.matchAll(/(?:ERROR|FATAL|PANIC):\s+([A-Z0-9]{5}):/g)].at(-1)?.[1];
 const sqlstate=candidate&&Object.hasOwn(RESTORE_SQLSTATE_CATEGORIES,candidate)?candidate:undefined;
 const statement=[...log.matchAll(/STATEMENT:\s+([^\n]+)/g)].at(-1)?.[1]??'';
 let operation='OTHER';
 const setting=/^SET\s+([a-z_]+)\s*=/i.exec(statement)?.[1]?.toLowerCase();
 if(RESTORE_SETTINGS.includes(setting))operation='SET_'+setting.toUpperCase();
 else if(/^SELECT\s+pg_catalog\.setval\s*\(/i.test(statement))operation='SEQUENCE_SETVAL';
 else {
  const found=/^(COPY|SET|SELECT|CREATE\s+(?:COLLATION|(?:UNIQUE\s+)?INDEX|FUNCTION|TABLE|VIEW|TYPE|SCHEMA|TRIGGER)|ALTER\s+(?:TABLE|FUNCTION))\b/i.exec(statement)?.[1]?.toUpperCase().replace(/\s+UNIQUE\s+/, ' ').replaceAll(/\s+/g,'_');
  if(RESTORE_OPERATIONS.includes(found))operation=found;
 }
 return {stage:restoreArchiveFailureStage(error,log),...(sqlstate?{sqlstate}:{}),operation};
}

export function sameBackupInventory(expected,actual) {
 if(!expected||!actual||typeof expected!=='object'||typeof actual!=='object'||Array.isArray(expected)||Array.isArray(actual))return false;
 const keys=Object.keys(expected).sort(),others=Object.keys(actual).sort();
 return keys.length===others.length&&keys.length>0&&keys.every((key,index)=>key===others[index]&&typeof expected[key]==='string'&&/^(0|[1-9][0-9]*)$/.test(expected[key])&&expected[key]===actual[key]);
}

export function assertBackupClientVersion(sourceVersion,clientVersion) {
 const match=typeof clientVersion==='string'?/^pg_dump \(PostgreSQL\) 17\.(\d+)(?:\s|$)/.exec(clientVersion.trim()):null;
 if(!Number.isInteger(sourceVersion)||sourceVersion<170000||sourceVersion>=180000||!match)throw new Error('INVALID_BACKUP_POSTGRES_VERSION');
 if(sourceVersion>170000+Number(match[1]))throw new Error('BACKUP_RESTORE_IMAGE_TOO_OLD');
}
