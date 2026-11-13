import {lstat,readFile,mkdtemp,open,link,rm} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {getPlatformProxy} from 'wrangler';
import {loadMigrationSnapshot} from './d1-migration-manifest';
import {buildMigrationManifest} from './migrations/d1/manifest';
import {prepareCommonImport} from './migrations/d1/prepare-import';
import {validateStagingTarget} from './migrations/d1/staging-target';
import {verifyMigratedSceneVectors} from './migrations/d1/verify-scene-delivery';
import {openVerifiedPostgresSource} from './migrations/d1/verified-postgres-source';
import {evaluatePairedSceneSearch,validateSearchEvaluationInput} from './migrations/d1/search-evaluation';
import type {StagingBindings} from './migrations/d1/staging-migration';
import {createD1SceneSearchRepository} from '../src/persistence/d1/scene-search';
import {openPostgresEmbeddingSceneSearch} from '../src/persistence/postgres/scene-search';
import {embeddingDimensions,resolveEmbeddingConfig} from '../src/lib/embedding-contract';
import type {Bindings} from '../src/types/bindings';

export function parseSearchEvaluationArguments(args: string[]) {
 const options=new Map<string,string>();
 for(let i=0;i<args.length;i+=2){
  if(!['--input','--output','--archive'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--')||options.has(args[i]))throw new Error('Invalid search evaluation arguments.');
  options.set(args[i],args[i+1]);
 }
 if(options.size!==3)throw new Error('Use --input <private cases.json> --archive <private corpus archive> --output <new private report.json>.');
 return {input:resolve(options.get('--input')!),output:resolve(options.get('--output')!),archive:resolve(options.get('--archive')!)};
}

/** Read-only comparison against the fixed, offline migration staging target. */
export async function main(args=process.argv.slice(2)) {
 const options=parseSearchEvaluationArguments(args);
 try{await lstat(options.output);throw new Error('Evaluation output already exists.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const info=await lstat(options.input);
 if(!info.isFile()||(info.mode&0o077)!==0||info.size<=0||info.size>128*1024*1024)throw new Error('Private bounded evaluation input is required.');
 const input=validateSearchEvaluationInput(JSON.parse(await readFile(options.input,'utf8')));
 if(process.env.PERSISTENCE_EVALUATION_SOURCE_OFFLINE!=='1')throw new Error('Source must be an explicitly frozen/offline rehearsal copy.');
 if(!process.env.DATABASE_URL)throw new Error('A read-only PostgreSQL rehearsal connection is required.');
 const source=new URL(process.env.DATABASE_URL);
 if(!['postgres:','postgresql:'].includes(source.protocol))throw new Error('PostgreSQL is required.');
 if(!['127.0.0.1','localhost','[::1]'].includes(source.hostname)&&source.searchParams.get('sslmode')!=='verify-full')throw new Error('Remote source TLS verification is required.');
 // Force read-only sessions for the evaluator, without altering runtime settings.
 source.searchParams.set('options','-c default_transaction_read_only=on -c statement_timeout=300000');
 const env={DATABASE_URL:source.toString(),EMBEDDING_PROFILE:process.env.EMBEDDING_PROFILE,
  EMBEDDING_MODEL:process.env.EMBEDDING_MODEL,EMBEDDING_BASE_URL:process.env.EMBEDDING_BASE_URL} as Bindings;
 const config=resolveEmbeddingConfig(env);
 if(embeddingDimensions(config)!==input.dimensions||config.model!==input.model)throw new Error('Evaluation model/profile differs from PostgreSQL configuration.');
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),configPath=join(root,'wrangler.d1-staging.jsonc');
 validateStagingTarget(await readFile(configPath,'utf8'));
 const manifest=buildMigrationManifest(await loadMigrationSnapshot(join(root,'drizzle')),await loadMigrationSnapshot(join(root,'drizzle-d1')));
 const prepared=await prepareCommonImport(options.archive,manifest);
 let directory: string|undefined;
 try{
  if(input.corpusSha256!==prepared.verified.archive_sha256)throw new Error('Evaluation corpus differs from the verified archive.');
  const verifiedSource=await openVerifiedPostgresSource({connectionString:source.toString(),archivePath:join(prepared.directory,'source.videoq-export.ndjson'),manifest});
  try{
   if(verifiedSource.archiveSha256!==input.corpusSha256)throw new Error('Frozen source archive changed during verification.');
   const proxy=await getPlatformProxy<StagingBindings>({configPath,envFiles:[],persist:false,remoteBindings:true});
   try{
    const {DB,SCENE_VECTORIZE_768:small,SCENE_VECTORIZE_1536:large}=proxy.env;
    const delivery=await verifyMigratedSceneVectors(DB,prepared.scenes,input.corpusSha256,{768:small,1536:large},{offlineStaging:true});
    if(!delivery.vectorize_delivery_complete)throw new Error('Vector delivery is incomplete.');
    const postgres=await openPostgresEmbeddingSceneSearch(env,undefined,undefined,{snapshot:verifiedSource.snapshot});
    try{
     const d1=createD1SceneSearchRepository(DB,input.dimensions===768?small:large,input.dimensions);
     const report={...await evaluatePairedSceneSearch({postgres,d1},input),target_archive_vectors_verified:true,
      source_offline_asserted:true,...verifiedSource.proof};
     await verifiedSource.assertLive();
     directory=await mkdtemp(join(dirname(options.output),'.videoq-search-evaluation-'));
     const path=join(directory,'report.json'),file=await open(path,'wx',0o600);
     try{await file.writeFile(JSON.stringify(report,null,2)+'\n');await file.sync();}finally{await file.close();}
     await link(path,options.output);
     console.info(JSON.stringify({event:'d1_search_evaluation_written',cohort:input.cohort,paired_searches:report.paired_searches,execution_complete:false}));
    }finally{await postgres.close();}
   }finally{await proxy.dispose();}
  }finally{await verifiedSource.dispose();}
 }finally{await prepared.dispose();if(directory)await rm(directory,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{await main();}catch{console.error('Search evaluation failed. Inspect private inputs, profile, frozen-source configuration and staging delivery; no records or credentials are logged.');process.exitCode=1;}
}
