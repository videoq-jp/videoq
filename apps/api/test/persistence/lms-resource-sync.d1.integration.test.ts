import {createD1Fixture} from './d1-fixture';
import {lmsResourceSyncContract,seedSyncOwner} from './contracts/lms-resource-sync.contract';
import type {Bindings} from '../../src/types/bindings';
lmsResourceSyncContract('D1 workerd',async()=>{
 const f=await createD1Fixture();const execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args.map(v=>typeof v==='boolean'?Number(v):v)).run();};
 try{
  await seedSyncOwner(execute);
  return {env:{DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings,execute,
   count:async(table:string)=>Number(await f.database.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')),
   quota:async()=>(await f.database.prepare("SELECT used_storage_bytes AS storage,used_upload_bytes AS upload FROM users WHERE id='owner'").first<{storage:number;upload:number}>())!,
   tasks:async()=>(await f.database.prepare('SELECT kind,payload,dedupe_key AS dedupeKey,available_at AS availableAt FROM external_tasks ORDER BY id').all<{kind:string;payload:string;dedupeKey:string;availableAt:string}>()).results.map(r=>({...r,payload:JSON.parse(r.payload) as Record<string,unknown>})),
   members:async(courseId:number)=>(await f.database.prepare('SELECT video_id AS id FROM video_course_members WHERE course_id=? ORDER BY video_id').bind(courseId).all<{id:number}>()).results.map(r=>r.id),
   failCommit:()=>execute("CREATE TRIGGER fail_sync BEFORE INSERT ON lms_resources BEGIN SELECT RAISE(ABORT,'injected sync failure'); END"),dispose:f.dispose};
 }catch(error){await f.dispose();throw error;}
});
