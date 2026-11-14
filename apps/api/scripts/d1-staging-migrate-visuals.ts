import type {R2Bucket} from '@cloudflare/workers-types';
import {readFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {getPlatformProxy} from 'wrangler';
import {loadMigrationSnapshot} from './d1-migration-manifest';
import {buildMigrationManifest} from './migrations/d1/manifest';
import {prepareCommonImport} from './migrations/d1/prepare-import';
import {importVisualObjects} from './migrations/d1/import-visuals';
import {r2VisualMigrationStorage} from './migrations/d1/r2-visual-storage';
import {validateVisualStagingTarget} from './migrations/d1/visual-staging-target';
import type {StagingBindings} from './migrations/d1/staging-migration';
export async function main(args=process.argv.slice(2)){
 if(args.length!==2||args[0]!=='--input'||!args[1]||args[1].startsWith('--'))throw new Error('Use --input <private verified archive>.');
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),configPath=join(root,'wrangler.d1-visual-staging.jsonc');
 validateVisualStagingTarget(await readFile(configPath,'utf8'));
 const manifest=buildMigrationManifest(await loadMigrationSnapshot(join(root,'drizzle')),await loadMigrationSnapshot(join(root,'drizzle-d1')));
 const prepared=await prepareCommonImport(resolve(args[1]),manifest);
 try{
  const proxy=await getPlatformProxy<StagingBindings&{SOURCE_VIDEO_BUCKET:R2Bucket;VIDEO_BUCKET:R2Bucket}>({configPath,envFiles:[],persist:false,remoteBindings:true});
  try{
   const sourceStorage=r2VisualMigrationStorage(proxy.env.SOURCE_VIDEO_BUCKET);
   // Expose only read to the importer: production objects are never created,
   // overwritten or deleted by this migration path.
   const source={read:(key:string,maximumBytes:number)=>sourceStorage.read(key,maximumBytes)},destination=r2VisualMigrationStorage(proxy.env.VIDEO_BUCKET);
   const result=await importVisualObjects(proxy.env.DB,prepared.visuals,prepared.verified.archive_sha256,prepared.directory,{source,destination,offlineStaging:true});
   console.info(JSON.stringify({phase:'visuals',...result,production_d1_cutover:false}));
  }finally{await proxy.dispose();}
 }finally{await prepared.dispose();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{await main();}catch{console.error('Visual staging migration failed; keep the target offline and inspect private inputs. No object contents or credentials are logged.');process.exitCode=1;}}
