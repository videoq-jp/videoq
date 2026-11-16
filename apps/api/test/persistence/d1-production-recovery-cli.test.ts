import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
const hooks=vi.hoisted(()=>({visuals:vi.fn(),restore:vi.fn(),fetch:vi.fn()}));
vi.mock('aws4fetch',()=>({AwsClient:class {fetch=hooks.fetch;}}));
vi.mock('../../scripts/migrations/d1/recover-visual-artifacts',()=>({recoverVisualArtifacts:hooks.visuals}));
vi.mock('../../scripts/migrations/d1/postwrite-recovery',async load=>({...await load<object>(),restoreProductionPostwriteSnapshot:hooks.restore}));
import {main} from '../../scripts/d1-production-recovery';
import {loadMigrationSnapshot} from '../../scripts/d1-migration-manifest';
import {buildMigrationManifest} from '../../scripts/migrations/d1/manifest';
import {recoveryHash} from '../../scripts/migrations/d1/postwrite-recovery';
let directory:string;
const runId='a'.repeat(32),actionId='b'.repeat(32),sourceSha='c'.repeat(40);
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'videoq-recovery-child-test-'));await chmod(directory,0o700);hooks.visuals.mockReset().mockResolvedValue({objects:0,bytes:0,sha256:'d'.repeat(64)});hooks.restore.mockReset().mockResolvedValue({postgresLoginFenceVerified:true,sha256:'e'.repeat(64)});hooks.fetch.mockReset();});
afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
async function fixture(){
 const manifest=buildMigrationManifest(await loadMigrationSnapshot('drizzle'),await loadMigrationSnapshot('drizzle-d1'));
 const value={version:1,runId,sourceSha,actionId,manifestSha256:recoveryHash(manifest),d1Fence:{},rows:{},vectors:[],sequenceHighWater:{}};
 const bytes=Buffer.from(JSON.stringify(value));
 const input=join(directory,'input.json'),state=join(directory,'state.json'),receipt=join(directory,'receipt.json');
 const plan={version:1,operationId:'00000000-0000-4000-8000-000000000001',target:{purpose:'production',host:'ep-old-truth-a1co51ud.ap-southeast-1.aws.neon.tech',databaseName:'neondb',rolePrefix:'videoq_'},roles:[{oid:42,name:'videoq_api_synthetic',can_login:true,superuser:false,create_db:false,create_role:false,replication:false,bypass_rls:false,inherit:true,connection_limit:-1,valid_until:null}],memberships:[],catalogSha256:'a'.repeat(64)};
 await writeFile(input,bytes,{mode:0o600});await writeFile(state,JSON.stringify(plan),{mode:0o600});
 const env={VIDEOQ_CUTOVER_RECOVERY_CHILD:'true',CODEBUILD_BUILD_ARN:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-rotation-prod:00000000-0000-4000-8000-000000000001',VIDEOQ_RECOVERY_INPUT_SHA256:createHash('sha256').update(bytes).digest('base64'),MAINTENANCE_RUN_ID:runId,MAINTENANCE_SOURCE_SHA:sourceSha,MAINTENANCE_RECOVERY_ACTION_ID:actionId,VIDEOQ_RECOVERY_R2_ACCESS_KEY_ID:'synthetic',VIDEOQ_RECOVERY_R2_SECRET_ACCESS_KEY:'synthetic',VIDEOQ_FENCE_ADMIN_DATABASE_URL:'postgresql://synthetic.invalid/neondb'};
 return {input,state,receipt,env,args:['--input',input,'--state',state,'--receipt',receipt],value};
}
describe('fixed AWS recovery child protocol (mocked remote services)',()=>{
 it('prepares visual artifacts, waits for the durable parent grant, then writes a private receipt',async()=>{
  const f=await fixture(),input=new PassThrough(),output=new PassThrough();let transcript='';
  output.on('data',chunk=>{transcript+=String(chunk);});
  const completed=main(f.args,f.env,{input,output});
  await vi.waitFor(()=>expect(transcript).toContain('recovery_prepared'));
  expect(hooks.visuals).toHaveBeenCalledOnce();expect(hooks.restore).not.toHaveBeenCalled();
  const prepared=JSON.parse(transcript.trim());
  input.write(JSON.stringify({authorize:true,snapshotSha256:prepared.snapshotSha256})+'\n');await completed;
  expect(hooks.restore).toHaveBeenCalledOnce();
  const restored=hooks.restore.mock.calls[0][0];expect(restored.plan.target.databaseName).toBe('neondb');expect(restored.upstreamStopped).toBe(true);expect(restored.expectedSnapshotSha256).toBe(prepared.snapshotSha256);
  const receipt=JSON.parse(await readFile(f.receipt,'utf8'));expect(receipt).toMatchObject({runId,actionId,sourceSha,productionSafe:false,postgresLoginFenceVerified:true,snapshotSha256:prepared.snapshotSha256});
  expect(transcript).toContain('recovery_committed');expect(transcript).not.toContain('postgresql:');input.destroy();output.destroy();
 });
 it('never enters PostgreSQL when the grant digest differs',async()=>{
  const f=await fixture(),input=new PassThrough(),output=new PassThrough();let prepared=false;output.on('data',()=>{prepared=true;});
  const result=main(f.args,f.env,{input,output});const assertion=expect(result).rejects.toThrow('DURABLE_RECOVERY_AUTHORIZATION_REQUIRED');
  await vi.waitFor(()=>expect(prepared).toBe(true));input.write(JSON.stringify({authorize:true,snapshotSha256:'f'.repeat(64)})+'\n');await assertion;
  expect(hooks.restore).not.toHaveBeenCalled();expect(await readFile(f.receipt,'utf8')).toBe('');input.destroy();output.destroy();
 });
 it('rejects changed bytes and ownership before any storage or database operation',async()=>{
  const f=await fixture();await expect(main(f.args,{...f.env,VIDEOQ_RECOVERY_INPUT_SHA256:'changed'})).rejects.toThrow('RECOVERY_INPUT_CHANGED');
  await expect(main(f.args,{...f.env,MAINTENANCE_RECOVERY_ACTION_ID:'f'.repeat(32)})).rejects.toThrow('RECOVERY_INPUT_OWNERSHIP_MISMATCH');
  await expect(main(f.args,{...f.env,VIDEOQ_CUTOVER_RECOVERY_CHILD:'false'})).rejects.toThrow('FIXED_AWS_RECOVERY_CHILD_REQUIRED');
  expect(hooks.visuals).not.toHaveBeenCalled();expect(hooks.restore).not.toHaveBeenCalled();
 });
 it('rejects public inputs and symbolic links',async()=>{
  const f=await fixture();await chmod(f.input,0o644);await expect(main(f.args,f.env)).rejects.toThrow('Private bounded regular input');
  await chmod(f.input,0o600);const link=join(directory,'link');await symlink(f.input,link);
  await expect(main(['--input',link,...f.args.slice(2)],f.env)).rejects.toThrow('Private bounded regular input');expect(hooks.restore).not.toHaveBeenCalled();
 });
 it('restricts storage to the production bucket and create-if-absent writes',async()=>{
  const f=await fixture();hooks.fetch.mockResolvedValue(new Response('',{status:412}));
  hooks.visuals.mockImplementation(async(_rows,_source,destination)=>{
   await destination.create('uploads/synthetic.bin',Buffer.from('private bytes'));throw Error('STOP_AFTER_STORAGE_PROBE');
  });
  await expect(main(f.args,f.env)).rejects.toThrow('STOP_AFTER_STORAGE_PROBE');
  expect(hooks.fetch).toHaveBeenCalledWith('https://12daec56fdba43f677f2766ee26a5a39.r2.cloudflarestorage.com/videoq-media-prod/media/uploads/synthetic.bin',expect.objectContaining({method:'PUT',headers:{'if-none-match':'*','content-type':'application/octet-stream'},redirect:'error'}));expect(hooks.restore).not.toHaveBeenCalled();
 });
 it('rejects unsafe paths before sending any storage request',async()=>{
  const f=await fixture();hooks.visuals.mockImplementation(async(_rows,source)=>source.read('../another-bucket',100));
  await expect(main(f.args,f.env)).rejects.toThrow('UNSAFE_RECOVERY_OBJECT');expect(hooks.fetch).not.toHaveBeenCalled();expect(hooks.restore).not.toHaveBeenCalled();
 });
 it('rejects oversized storage bodies before the database grant',async()=>{
  const f=await fixture();hooks.fetch.mockResolvedValue(new Response('12345'));
  hooks.visuals.mockImplementation(async(_rows,source)=>source.read('uploads/synthetic.json',4));
  await expect(main(f.args,f.env)).rejects.toThrow('RECOVERY_OBJECT_TOO_LARGE');expect(hooks.restore).not.toHaveBeenCalled();
 });
});
