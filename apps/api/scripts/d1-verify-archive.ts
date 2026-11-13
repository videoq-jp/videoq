import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {loadMigrationSnapshot} from './d1-migration-manifest';
import {buildMigrationManifest} from './migrations/d1/manifest';
import {verifyPostgresArchive,ArchiveVerificationError} from './migrations/d1/verify-archive';
export async function main(args=process.argv.slice(2)){
 if(!([2,4].includes(args.length))||args[0]!=='--input'||args.length===4&&args[2]!=='--max-line-bytes')throw new ArchiveVerificationError('Use --input <private archive> [--max-line-bytes <bytes>].');
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),manifest=buildMigrationManifest(await loadMigrationSnapshot(resolve(root,'drizzle')),await loadMigrationSnapshot(resolve(root,'drizzle-d1')));
 const result=await verifyPostgresArchive(resolve(args[1]),manifest,{maxLineBytes:args.length===4?Number(args[3]):undefined});
 console.info(JSON.stringify({verified:result.verified,version:result.version,tables:result.tables,rows:result.rows,archive_sha256:result.archive_sha256,execution_complete:result.execution_complete}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{await main();}catch(error){console.error(JSON.stringify({event:'d1_archive_verification_failed',reason:error instanceof ArchiveVerificationError?error.message:'Unable to read or validate archive.'}));process.exitCode=1;}}
