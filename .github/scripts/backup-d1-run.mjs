import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {backupD1ExportRequested} from './backup-archive.mjs';
const execute=promisify(execFile);
/** Invoke only the independently installed runtime, passing a temporary restored
 * loopback credential. Never inherit the source URL, PG_*, AWS or OIDC variables. */
export async function exportRestoredBackup({databaseUrl,directory,env=process.env},run=execute) {
 if(!backupD1ExportRequested(env))return undefined;
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
 const childEnv=Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(key=>env[key]).map(key=>[key,env[key]]));
 childEnv.DATABASE_URL=databaseUrl;childEnv.VIDEOQ_BACKUP_ISOLATED_EXPORT='true';
 const {stdout}=await run(process.execPath,['--import',pathToFileURL(join(root,'.github/operations-tools/node_modules/tsx/dist/loader.mjs')).href,
  join(root,'.github/scripts/backup-d1-export.mts'),'--output',join(directory,'d1-source.videoq-export.ndjson')],
 {cwd:root,env:childEnv,timeout:900000,maxBuffer:1000000});
 let proof;try{proof=JSON.parse(stdout.trim());}catch{throw new Error('D1_BACKUP_EXPORT_NOT_VERIFIED');}
 if(proof.event!=='restored_backup_d1_archive_verified'||proof.version!==3||!Number.isSafeInteger(proof.tables)||proof.tables<1||
   typeof proof.rows!=='string'||!/^(0|[1-9][0-9]*)$/.test(proof.rows)||
   !/^[0-9a-f]{64}$/.test(proof.archive_sha256)||!Number.isSafeInteger(proof.file_bytes)||proof.file_bytes<=0||
   !/^[A-Za-z0-9+/]{43}=$/.test(proof.file_sha256_base64)||proof.execution_complete!==false)throw new Error('D1_BACKUP_EXPORT_NOT_VERIFIED');
 return {version:proof.version,tables:proof.tables,rows:proof.rows,archive_sha256:proof.archive_sha256,
  file_bytes:proof.file_bytes,file_sha256_base64:proof.file_sha256_base64};
}
