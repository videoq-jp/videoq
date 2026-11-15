import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {createMaterialsSyncRepository} from '../../../src/persistence/factory';
import {materialStateKey} from '../../../src/features/lms/material-state-key';
import {getLmsResource,syncLmsResource} from '../../../src/repositories/lms-resource-repository';
import {resourceManifestSchema} from '../../../src/features/lms/resource';
import type {Bindings} from '../../../src/types/bindings';
import type {MaterialsLease} from '../../../src/persistence/contracts/materials-sync-repository';
type Fixture={taskCount:()=>Promise<number>;env:Bindings;execute:(sql:string,args?:unknown[])=>Promise<void>;state:(id:string)=>Promise<{payload:Record<string,unknown>;expiresAt:string}|null>;cursor:()=>Promise<number>;dispose:()=>Promise<void>};
export function materialsSyncContract(name:string,setup:()=>Promise<Fixture>){
 describe(`${name} materials synchronization state contract`,()=>{
  let f:Fixture;beforeEach(async()=>{f=await setup();});afterEach(async()=>{await f?.dispose();});
  const claim=async()=>{const result=await (await createMaterialsSyncRepository(f.env)).claimContext('school',await materialStateKey('lti-materials-lease:','school','context'),crypto.randomUUID());if(result.status!=='claimed')throw new Error(result.status);return result;};
  it('claims one context, distinguishes unavailable connections and normalizes connection data',async()=>{
   const repo=await createMaterialsSyncRepository(f.env),first=await claim();expect(first.connection).toMatchObject({id:'school',ownerUserId:'installer',clientId:'client',deploymentId:'2',materialsCursor:0,materialsService:{endpoint:'https://lms.example/materials'}});
   expect(await repo.claimContext('school',first.lease.id,crypto.randomUUID())).toEqual({status:'busy'});expect(await repo.owns(first.lease)).toBe(true);
   expect(await repo.claimContext('missing','missing',crypto.randomUUID())).toEqual({status:'unavailable'});
   await repo.release(first.lease);expect(await repo.owns(first.lease)).toBe(false);await claim();
  });
  it('fences expired/replaced handles and stale release',async()=>{
   const repo=await createMaterialsSyncRepository(f.env),old=(await claim()).lease;
   await f.execute('UPDATE lti_credentials SET expires_at=? WHERE id=?',['2000-01-01',old.id]);expect(await repo.owns(old)).toBe(false);
   const current=(await claim()).lease;await repo.release(old);expect(await repo.owns(current)).toBe(true);
   await expect(repo.prepareExport(old,'export','context','old')).rejects.toThrow('lease');
   expect(await repo.saveExportJob(old,'export','old','job')).toBe(false);
  });
  it('persists an attempt before HTTP and reuses it across retries without extending expiry',async()=>{
   const repo=await createMaterialsSyncRepository(f.env),lease=(await claim()).lease,key=await materialStateKey('lti-export:','school','source',1);
   const results=await Promise.all([repo.prepareExport(lease,key,'context','first'),repo.prepareExport(lease,key,'context','second')]);expect(results[0]).toEqual(results[1]);
   const before=await f.state(key);expect(await repo.saveExportJob(lease,key,results[0].attempt,'job')).toBe(true);
   expect(await repo.prepareExport(lease,key,'context','ignored')).toEqual({attempt:results[0].attempt,jobId:'job'});expect((await f.state(key))?.expiresAt).toBe(before?.expiresAt);
   expect(await repo.saveExportJob(lease,key,'wrong','late')).toBe(false);expect(await repo.deleteExport(lease,key,'wrong')).toBe(false);
  });
  it('does not let an old worker overwrite or delete a newer export attempt',async()=>{
   const repo=await createMaterialsSyncRepository(f.env),old=(await claim()).lease;await repo.prepareExport(old,'export','context','old');
   await f.execute('UPDATE lti_credentials SET expires_at=?',['2000-01-01']);const current=(await claim()).lease;
   expect(await repo.prepareExport(current,'export','context','new')).toEqual({attempt:'new'});
   expect(await repo.saveExportJob(old,'export','old','late')).toBe(false);expect(await repo.deleteExport(old,'export','old')).toBe(false);
   expect(await repo.saveExportJob(current,'export','new','current')).toBe(true);expect((await f.state('export'))?.payload.jobId).toBe('current');
  });
  it('invalidates ownership when a connection is disabled or its configuration changes',async()=>{
   const repo=await createMaterialsSyncRepository(f.env),lease=(await claim()).lease;await repo.prepareExport(lease,'export','context','attempt');
   await f.execute('UPDATE lms_installations SET deployment_id=? WHERE id=?',['new','school']);expect(await repo.owns(lease)).toBe(false);expect(await repo.saveExportJob(lease,'export','attempt','late')).toBe(false);
   await f.execute('UPDATE lms_installations SET deployment_id=?,active=false WHERE id=?',['2','school']);expect(await repo.owns(lease)).toBe(false);expect(await repo.deleteExport(lease,'export','attempt')).toBe(false);
  });
  it('rejects forged installation scope and reserves current state only for the live lease',async()=>{
   const repo=await createMaterialsSyncRepository(f.env),lease=(await claim()).lease,forged:MaterialsLease={...lease,installationId:'other'};
   expect(await repo.owns(forged)).toBe(false);await expect(repo.prepareExport(forged,'export','context','attempt')).rejects.toThrow('lease');
   const invalid={...lease,token:'different'};await expect(repo.prepareExport(invalid,'export','context','attempt')).rejects.toThrow('lease');
   expect(await f.state('export')).toBeNull();
  });
  it('claims one poll and prevents a stale poller from overwriting cursor state',async()=>{
   const repo=await createMaterialsSyncRepository(f.env),claims=await Promise.all([repo.claimNext(crypto.randomUUID()),repo.claimNext(crypto.randomUUID())]);
   expect(claims.filter(Boolean)).toHaveLength(1);const old=claims.find(Boolean)!;expect(await repo.owns(old.lease)).toBe(true);
   await f.execute('UPDATE lti_credentials SET expires_at=? WHERE id=?',['2000-01-01',old.lease.id]);await f.execute('UPDATE lms_installations SET next_materials_sync_at=?',['2000-01-01']);
   const current=await repo.claimNext(crypto.randomUUID());expect(current).not.toBeNull();
   expect(await repo.finishPoll(old.lease,9,30)).toBe(false);await repo.release(old.lease);expect(await repo.owns(current!.lease)).toBe(true);
   expect(await repo.finishPoll(current!.lease,1,10)).toBe(true);expect(await f.cursor()).toBe(1);await repo.release(current!.lease);
  });
  it('does not interchange poll and context lease permissions',async()=>{
   const repo=await createMaterialsSyncRepository(f.env),context=(await claim()).lease,poll=await repo.claimNext(crypto.randomUUID());if(!poll)throw new Error('missing poll');
   await expect(repo.prepareExport(poll.lease,'export','context','attempt')).rejects.toThrow('lease');
   expect(await repo.finishPoll(context,1,10)).toBe(false);
   const manifest=resourceManifestSchema.parse({generation:1,kind:'course',contextId:'context',resourceLinkId:'entry',enabled:true,title:'entry'});
   await expect(syncLmsResource(f.env,{id:'school',ownerUserId:'owner',materialsLease:poll.lease},'entry',manifest)).rejects.toThrow('lease');
  });
  it('confirms the current upload and creates exactly one durable job',async()=>{
   const repo=await createMaterialsSyncRepository(f.env),lease=(await claim()).lease;
   const m=resourceManifestSchema.parse({generation:1,contextId:'context',resourceLinkId:'source',enabled:true,title:'Video',file:{filename:'video.mp4',size:100,contentType:'video/mp4',contentHash:'a'.repeat(64)}});
   const r=await syncLmsResource(f.env,{id:'school',ownerUserId:'owner'},'source',m);
   const data=await getLmsResource(f.env,{id:'school',ownerUserId:'owner'},'source');if(!data?.video)throw new Error('missing video');
   const upload={externalId:'source',generation:1,videoId:r.videoId!,fileKey:data.video.file};
   expect(await repo.confirmUpload(lease,{...upload,generation:2})).toBe(false);
   expect(await repo.confirmUpload(lease,{...upload,fileKey:'wrong'})).toBe(false);
   const poll=await repo.claimNext(crypto.randomUUID());if(!poll)throw new Error('missing poll');
   expect(await repo.confirmUpload(poll.lease,upload)).toBe(false);expect(await f.taskCount()).toBe(0);
   expect(await repo.confirmUpload(lease,upload)).toMatchObject({videoId:r.videoId});
   expect(await repo.confirmUpload(lease,upload)).toBe(false);expect(await f.taskCount()).toBe(1);
   expect(await getLmsResource(f.env,{id:'school',ownerUserId:'owner'},'source')).toMatchObject({video:{status:'pending'}});
  });
  it('rejects upload confirmation after lease expiry without emitting a job',async()=>{
   const repo=await createMaterialsSyncRepository(f.env),lease=(await claim()).lease;
   const m=resourceManifestSchema.parse({generation:1,contextId:'context',resourceLinkId:'source',enabled:true,title:'Video',file:{filename:'video.mp4',size:100,contentType:'video/mp4',contentHash:'a'.repeat(64)}});
   const r=await syncLmsResource(f.env,{id:'school',ownerUserId:'owner'},'source',m);
   const data=await getLmsResource(f.env,{id:'school',ownerUserId:'owner'},'source');if(!data?.video)throw new Error('missing video');
   await f.execute('UPDATE lti_credentials SET expires_at=? WHERE id=?',['2000-01-01',lease.id]);
   expect(await repo.confirmUpload(lease,{externalId:'source',generation:1,videoId:r.videoId!,fileKey:data.video.file})).toBe(false);
   expect(await f.taskCount()).toBe(0);
   expect(await getLmsResource(f.env,{id:'school',ownerUserId:'owner'},'source')).toMatchObject({video:{status:'uploading'}});
  });
  it('fences resource commits with the same context lease proof',async()=>{
   const lease=(await claim()).lease;
   await f.execute('UPDATE lti_credentials SET expires_at=? WHERE id=?',['2000-01-01',lease.id]);
   const manifest=resourceManifestSchema.parse({generation:1,kind:'course',contextId:'context',resourceLinkId:'entry',enabled:true,title:'entry'});
   await expect(syncLmsResource(f.env,{id:'school',ownerUserId:'owner',materialsLease:lease},'entry',manifest)).rejects.toThrow('lease');
  });
 });
}
