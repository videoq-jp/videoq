import {mkdtemp,writeFile,rm,chmod,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,it,expect,vi} from 'vitest';
vi.mock('wrangler',()=>({getPlatformProxy:vi.fn(()=>{throw new Error('Network must not be reached');})}));
import {getPlatformProxy} from 'wrangler';
import {main} from '../../scripts/d1-write-fence';
const databaseId='00000000-0000-4000-8000-000000000001';
const target={version:1,accountId:'12daec56fdba43f677f2766ee26a5a39',databaseId,databaseName:'videoq-fence-test',purpose:'isolated-rehearsal'};
const state={target,manifestSha256:'obsolete-contract',plan:{version:1,databaseId,operationId:'1'.repeat(32),tables:['users'],schemaSha256:'2'.repeat(64)}};
async function workspace(){const path=await mkdtemp(join(tmpdir(),'videoq-fence-command-'));await chmod(path,0o700);return path;}
describe('write-fence operator command preflight',()=>{
 it('rejects public input and another account before opening a remote binding',async()=>{
  const p=await workspace();try{
   const file=join(p,'target.json'),output=join(p,'state.json');await writeFile(file,JSON.stringify(target),{mode:0o644});
   await expect(main(['--mode','prepare','--target',file,'--state',output])).rejects.toThrow('Private bounded');
   await chmod(file,0o600);await writeFile(file,JSON.stringify({...target,accountId:'0'.repeat(32)}));
   await expect(main(['--mode','prepare','--target',file,'--state',output])).rejects.toThrow();expect(getPlatformProxy).not.toHaveBeenCalled();
  }finally{await rm(p,{recursive:true,force:true});}
 });
 it('does not overwrite an existing plan or follow a mismatched mutation confirmation',async()=>{
  const p=await workspace();try{
   const file=join(p,'target.json'),output=join(p,'state.json');await writeFile(file,JSON.stringify(target),{mode:0o600});await writeFile(output,JSON.stringify(state),{mode:0o600});
   await expect(main(['--mode','prepare','--target',file,'--state',output])).rejects.toThrow('EEXIST');
   expect(JSON.parse(await readFile(output,'utf8'))).toEqual(state);
   vi.stubEnv('VIDEOQ_MIGRATION_UPSTREAM_STOPPED','1');
   await expect(main(['--mode','install','--state',output,'--confirm-database','00000000-0000-4000-8000-000000000002'])).rejects.toThrow('Exact database');
   expect(getPlatformProxy).not.toHaveBeenCalled();
  }finally{vi.unstubAllEnvs();await rm(p,{recursive:true,force:true});}
 });
 it('requires an upstream-stop assertion and current migration contract before remote mutation',async()=>{
  const p=await workspace();try{
   const output=join(p,'state.json');await writeFile(output,JSON.stringify(state),{mode:0o600});vi.stubEnv('VIDEOQ_MIGRATION_UPSTREAM_STOPPED','');
   const args=['--mode','release','--state',output,'--confirm-database',databaseId];await expect(main(args)).rejects.toThrow('Exact database');
   vi.stubEnv('VIDEOQ_MIGRATION_UPSTREAM_STOPPED','1');await expect(main(args)).rejects.toThrow('current migration contract');expect(getPlatformProxy).not.toHaveBeenCalled();
  }finally{vi.unstubAllEnvs();await rm(p,{recursive:true,force:true});}
 });
});
