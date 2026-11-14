import {readPrivateInput} from './migrations/d1/private-input';
import {readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {getPlatformProxy} from 'wrangler';
import {z} from 'zod';
import {validateSyntheticStagingTarget,SYNTHETIC_STAGING_DATABASE_ID} from './migrations/d1/synthetic-staging-target';
import type {StagingBindings} from './migrations/d1/staging-migration';
import {fingerprintRecoveryStaging,RecoveryProbeError} from './migrations/d1/recovery-fingerprint';
const stateSchema=z.object({version:z.literal(1),database_id:z.literal(SYNTHETIC_STAGING_DATABASE_ID),nonce:z.uuid(),snapshot:z.object({tables:z.array(z.object({name:z.string(),rows:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/)})),sha256:z.string().regex(/^[a-f0-9]{64}$/)})});
export async function main(args=process.argv.slice(2)){
 if(args.length!==4||args[0]!=='--mode'||!['prepare','mutate','verify'].includes(args[1])||args[2]!=='--state')throw new RecoveryProbeError('Use --mode prepare|mutate|verify --state <private state file>.');
 const mode=args[1],statePath=resolve(args[3]),root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),configPath=resolve(root,'wrangler.d1-staging.v2.jsonc');validateSyntheticStagingTarget(await readFile(configPath,'utf8'));
 let state:z.infer<typeof stateSchema>|undefined;
 if(mode!=='prepare')state=stateSchema.parse(JSON.parse((await readPrivateInput(statePath,4*1024*1024)).toString('utf8')) as unknown);
 const proxy=await getPlatformProxy<StagingBindings>({configPath,envFiles:[],persist:false,remoteBindings:true});
 try{
  const snapshot=await fingerprintRecoveryStaging(proxy.env.DB);
  if(mode==='prepare'){await writeFile(statePath,JSON.stringify({version:1,database_id:SYNTHETIC_STAGING_DATABASE_ID,nonce:crypto.randomUUID(),snapshot}),{flag:'wx',mode:0o600});console.info(JSON.stringify({recovery_state_prepared:true,tables:snapshot.tables.length,rows:snapshot.tables.reduce((sum,table)=>sum+table.rows,0),snapshot_sha256:snapshot.sha256,production_modified:false}));return;}
  if(snapshot.sha256!==state!.snapshot.sha256)throw new RecoveryProbeError('Recovery staging state differs from the recorded snapshot.');
  if(mode==='verify'){console.info(JSON.stringify({recovery_snapshot_verified:true,tables:snapshot.tables.length,snapshot_sha256:snapshot.sha256,production_modified:false}));return;}
  const marker='Synthetic recovery probe '+state!.nonce;
  const result=await proxy.env.DB.prepare("UPDATE videos SET title=? WHERE id=1 AND user_id='migration-rehearsal-owner' RETURNING id").bind(marker).all();if(result.results.length!==1)throw new RecoveryProbeError('Recovery probe mutation did not affect the expected synthetic row.');
  const changed=await fingerprintRecoveryStaging(proxy.env.DB);if(changed.sha256===state!.snapshot.sha256)throw new RecoveryProbeError('Recovery probe mutation was not observed.');
  console.info(JSON.stringify({recovery_probe_mutation_observed:true,production_modified:false}));
 }finally{await proxy.dispose();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{await main();}catch(error){console.error(JSON.stringify({event:'staging_recovery_probe_failed',reason:error instanceof RecoveryProbeError?error.message:'Recovery probe failed; keep the dedicated target offline and inspect the saved state.'}));process.exitCode=1;}}
