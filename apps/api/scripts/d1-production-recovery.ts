/** Fixed AWS child: private input -> verified R2 compatibility objects -> one
 * authorized, login-fenced Neon transaction. No general AWS/Cloudflare token. */
import {createHash} from 'node:crypto';
import {lstat,open} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import type {Readable,Writable} from 'node:stream';
import {AwsClient} from 'aws4fetch';
import {z} from 'zod';
import {loadMigrationSnapshot} from './d1-migration-manifest';
import {buildMigrationManifest} from './migrations/d1/manifest';
import {readPrivateInput} from './migrations/d1/private-input';
import {postgresLoginFencePlanSchema} from './migrations/d1/postgres-login-fence';
import {restoreProductionPostwriteSnapshot,recoveryHash,type RecoveryRows,type RecoveryVector} from './migrations/d1/postwrite-recovery';
import {recoverVisualArtifacts} from './migrations/d1/recover-visual-artifacts';
import {isSafeMediaPath} from '../src/shared/media-path';
import {awaitRecoveryAuthorization} from './migrations/d1/recovery-authorization';
const hex=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().regex(/^[a-f0-9]{32}$/);
const inputSchema=z.object({version:z.literal(1),runId:id,sourceSha:z.string().regex(/^[a-f0-9]{40}$/),actionId:id,manifestSha256:hex,d1Fence:z.unknown(),rows:z.record(z.string(),z.array(z.record(z.string(),z.unknown()))),vectors:z.array(z.object({id:z.string(),values:z.array(z.number()),metadata:z.record(z.string(),z.unknown())}).strict()),sequenceHighWater:z.record(z.string(),z.string())}).strict();
const hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('base64');
export async function main(args=process.argv.slice(2),env=process.env,io:{input:Readable;output:Writable}={input:process.stdin,output:process.stdout}){
 if(args.length!==6||args[0]!=='--input'||args[2]!=='--state'||args[4]!=='--receipt'||env.VIDEOQ_CUTOVER_RECOVERY_CHILD!=='true'||!/^arn:aws:codebuild:ap-northeast-1:257240362763:build\/videoq-db-rotation-prod:[a-f0-9-]{36}$/.test(env.CODEBUILD_BUILD_ARN??''))throw Error('FIXED_AWS_RECOVERY_CHILD_REQUIRED');
 const bytes=await readPrivateInput(resolve(args[1]),128*1024*1024);
 if(hash(bytes)!==env.VIDEOQ_RECOVERY_INPUT_SHA256)throw Error('RECOVERY_INPUT_CHANGED');
 const input=inputSchema.parse(JSON.parse(bytes.toString()));
 if(input.runId!==env.MAINTENANCE_RUN_ID||input.sourceSha!==env.MAINTENANCE_SOURCE_SHA||input.actionId!==env.MAINTENANCE_RECOVERY_ACTION_ID)throw Error('RECOVERY_INPUT_OWNERSHIP_MISMATCH');
 const plan=postgresLoginFencePlanSchema.parse(JSON.parse((await readPrivateInput(resolve(args[3]),128*1024)).toString()));
 if(plan.target.purpose!=='production')throw Error('PRODUCTION_ORIGINAL_PLAN_REQUIRED');
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),manifest=buildMigrationManifest(await loadMigrationSnapshot(resolve(root,'drizzle')),await loadMigrationSnapshot(resolve(root,'drizzle-d1')));
 if(recoveryHash(manifest)!==input.manifestSha256)throw Error('RECOVERY_MAPPING_CHANGED');
 const output=resolve(args[5]),parent=await lstat(dirname(output));
 if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o077)||parent.uid!==process.getuid?.())throw Error('PRIVATE_RECOVERY_OUTPUT_REQUIRED');
 const file=await open(output,'wx',0o600);
 try{
  const access=env.VIDEOQ_RECOVERY_R2_ACCESS_KEY_ID,secret=env.VIDEOQ_RECOVERY_R2_SECRET_ACCESS_KEY;
  if(!access||!secret||/[\r\n\0]/.test(access+secret)||access.length>1024||secret.length>4096)throw Error('SCOPED_RECOVERY_STORAGE_REQUIRED');
  const signer=new AwsClient({accessKeyId:access,secretAccessKey:secret,service:'s3',region:'auto'});
  const uri=(key:string)=>{if(!isSafeMediaPath(key))throw Error('UNSAFE_RECOVERY_OBJECT');return 'https://12daec56fdba43f677f2766ee26a5a39.r2.cloudflarestorage.com/videoq-media-prod/'+key.split('/').map(encodeURIComponent).join('/');};
  const read=async(key:string,maximum:number)=>{
   if(!Number.isSafeInteger(maximum)||maximum<1||maximum>32*1024*1024)throw Error('RECOVERY_OBJECT_BUDGET_REQUIRED');
   const response=await signer.fetch(uri(key),{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000)});
   if(response.status===404)return null;
   if(!response.ok||!response.body)throw Error('RECOVERY_OBJECT_READ_FAILED');
   const chunks:Uint8Array[]=[];let size=0;const reader=response.body.getReader();
   try{for(;;){const next=await reader.read();if(next.done)break;const value:unknown=next.value;if(!(value instanceof Uint8Array))throw Error('RECOVERY_OBJECT_READ_FAILED');size+=value.byteLength;if(size>maximum)throw Error('RECOVERY_OBJECT_TOO_LARGE');chunks.push(value);}}
   finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   return Buffer.concat(chunks);
  };
  // Source and legacy-compatibility namespaces share the existing media bucket.
  // Create-if-absent and byte comparison forbid overwriting any source/object.
  const source={read},destination={read,create:async(key:string,value:Uint8Array)=>{
   const response=await signer.fetch(uri(key),{method:'PUT',headers:{'if-none-match':'*','content-type':'application/octet-stream'},body:Buffer.from(value),redirect:'error',signal:AbortSignal.timeout(30000)});
   if(!response.ok&&response.status!==412)throw Error('RECOVERY_OBJECT_CREATE_FAILED');
  }};
  const rows=input.rows as RecoveryRows,vectors=input.vectors as RecoveryVector[];
  const visualRecovery=await recoverVisualArtifacts(rows,source,destination,true);
  const snapshotSha256=recoveryHash({rows,vectors,sequenceHighWater:input.sequenceHighWater,visualRecovery});
  io.output.write(JSON.stringify({event:'recovery_prepared',snapshotSha256,manifestSha256:input.manifestSha256,inputSha256:hash(bytes)})+'\n');
  await awaitRecoveryAuthorization(io.input,snapshotSha256);
  const connectionString=env.VIDEOQ_FENCE_ADMIN_DATABASE_URL;
  if(!connectionString)throw Error('PRIVATE_RECOVERY_CONNECTION_REQUIRED');
  const result=await restoreProductionPostwriteSnapshot({connectionString,plan,upstreamStopped:true,manifest,rows,vectors,sequenceHighWater:input.sequenceHighWater,visualRecovery,limits:{rowsPerTable:10000,bytes:128*1024*1024},expectedSnapshotSha256:snapshotSha256,expectedManifestSha256:input.manifestSha256});
  const receipt={version:1,runId:input.runId,sourceSha:input.sourceSha,actionId:input.actionId,inputSha256:hash(bytes),snapshotSha256,manifestSha256:input.manifestSha256,postgresLoginFenceVerified:result.postgresLoginFenceVerified,restoredSha256:result.sha256,visualRecovery,productionSafe:false};
  await file.writeFile(JSON.stringify(receipt));await file.sync();
  io.output.write(JSON.stringify({event:'recovery_committed',snapshotSha256,postgresLoginFenceVerified:true})+'\n');
 }finally{await file.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{await main();}catch{console.error('FIXED_PRODUCTION_RECOVERY_FAILED_KEEP_WRITERS_STOPPED');process.exitCode=1;}}
