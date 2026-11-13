/** Isolated restored-backup export only. This entrypoint never retrieves source
 * credentials, contacts S3 or loads application-installed dependencies. */
import {lstat,realpath,symlink} from 'node:fs/promises';
import {dirname,resolve,join,basename} from 'node:path';
import {fileURLToPath,pathToFileURL,URL} from 'node:url';

export async function main(args=process.argv.slice(2)) {
 if(process.env.VIDEOQ_BACKUP_ISOLATED_EXPORT!=='true'||args.length!==2||args[0]!=='--output')throw new Error('Isolated backup export context is required.');
 if(!process.env.DATABASE_URL)throw new Error('Restored database connection is required.');
 const url=new URL(process.env.DATABASE_URL),port=Number(url.port);
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.username!=='postgres'||!url.password||
    url.pathname!=='/postgres'||url.search||url.hash||!Number.isInteger(port)||port<1||port>65535)throw new Error('Only an explicit loopback restored database is allowed.');
 const output=resolve(args[1]),directory=await lstat(dirname(output));
 if(basename(output)!=='d1-source.videoq-export.ndjson'||!directory.isDirectory()||(directory.mode&0o077)!==0||directory.uid!==process.getuid?.())throw new Error('Private parent-owned export directory is required.');
 try{await lstat(output);throw new Error('Export output already exists.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),modules=join(root,'node_modules'),isolated=join(root,'.github/operations-tools/node_modules');
 // Only a clean operator bundle may create this link. Never replace or load the
 // application node_modules, even when running a local synthetic rehearsal.
 try{await lstat(modules);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await symlink('.github/operations-tools/node_modules',modules,'dir');}
 if(!(await lstat(modules)).isSymbolicLink()||await realpath(modules)!==await realpath(isolated))throw new Error('Isolated operations dependencies are required.');
 // The source manifest and every runtime dependency below come from the reviewed
 // immutable operator bundle and its separately installed/signature-checked lock.
 const [{default:pg},{loadMigrationSnapshot},{buildMigrationManifest},{exportPostgresArchive},{verifyPostgresArchive}]=await Promise.all([
  import('pg'),import('../../apps/api/scripts/d1-migration-manifest'),import('../../apps/api/scripts/migrations/d1/manifest'),
  import('../../apps/api/scripts/migrations/d1/export'),import('../../apps/api/scripts/migrations/d1/verify-archive'),
 ]);
 const api=join(root,'apps/api'),manifest=buildMigrationManifest(await loadMigrationSnapshot(join(api,'drizzle')),await loadMigrationSnapshot(join(api,'drizzle-d1')));
 url.searchParams.set('options','-c default_transaction_read_only=on');
 const client=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:10000,statement_timeout:300000,ssl:false,application_name:'videoq-restored-backup-d1-export'});
 client.on('error',()=>undefined);
 try{
  await client.connect();await exportPostgresArchive(client,manifest,output,{statementTimeoutMs:300000});
  const verified=await verifyPostgresArchive(output,manifest);
  console.info(JSON.stringify({event:'restored_backup_d1_archive_verified',version:verified.version,tables:verified.tables,rows:verified.rows,
   archive_sha256:verified.archive_sha256,execution_complete:false}));
 }finally{await client.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(await realpath(resolve(process.argv[1]))).href){
 try{await main();}catch{console.error('Restored-backup D1 export failed. Check private output, schema coverage and isolated runtime; no records or credentials are logged.');process.exitCode=1;}
}
