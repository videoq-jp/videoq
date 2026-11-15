import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {getPlatformProxy} from 'wrangler';
import {loadMigrationSnapshot} from './d1-migration-manifest';
import {buildMigrationManifest} from './migrations/d1/manifest';
import {validateStagingTarget} from './migrations/d1/staging-target';
import {parseStagingMigrationArguments,runStagingMigration,stagingMigrationExitCode,type StagingBindings} from './migrations/d1/staging-migration';
export async function main(args=process.argv.slice(2)){
 const options=parseStagingMigrationArguments(args),root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),configPath=resolve(root,'wrangler.d1-staging.jsonc');
 validateStagingTarget(await readFile(configPath,'utf8'));
 const manifest=buildMigrationManifest(await loadMigrationSnapshot(resolve(root,'drizzle')),await loadMigrationSnapshot(resolve(root,'drizzle-d1')));
 const result=await runStagingMigration({...options,input:resolve(options.input)},manifest,()=>getPlatformProxy<StagingBindings>({configPath,envFiles:[],persist:false,remoteBindings:true}));
 console.info(JSON.stringify(result));process.exitCode=stagingMigrationExitCode(result);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{await main();}catch{console.error(JSON.stringify({event:'d1_staging_migration_failed',reason:'Staging migration failed; keep the target offline and inspect the archive, configuration and phase before retry.'}));process.exitCode=1;}}
