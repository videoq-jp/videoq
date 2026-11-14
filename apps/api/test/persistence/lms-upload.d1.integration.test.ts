import {vi} from 'vitest';
import {lmsUploadContract} from './contracts/lms-upload.contract';
import {seedSyncOwner} from './contracts/lms-resource-sync.contract';
import {createD1Fixture} from './d1-fixture';
import {digest} from '../../src/features/lti/store';
import type {Bindings} from '../../src/types/bindings';
vi.mock('../../src/lib/external-tasks',async original=>({...await original<typeof import('../../src/lib/external-tasks')>(),processExternalTaskById:vi.fn(async()=>{})}));
lmsUploadContract('D1 workerd',async()=>{
 const f=await createD1Fixture(),execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args).run();};
 try{await seedSyncOwner(execute);await execute("UPDATE lms_installations SET materials_service=NULL,sync_token_hash=? WHERE id='school'",[await digest('f'.repeat(64))]);return {env:{DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings,execute,
  tasks:async()=>(await f.database.prepare('SELECT id,kind,payload FROM external_tasks ORDER BY id').all<{id:number;kind:string;payload:string}>()).results.map(r=>({...r,payload:JSON.parse(r.payload) as Record<string,unknown>})),
  quota:async()=>{const row=await f.database.prepare("SELECT used_storage_bytes AS storage,used_upload_bytes AS upload FROM users WHERE id='owner'").first<{storage:number;upload:number}>();return row!;},
  failAdopt:()=>execute("CREATE TRIGGER fail_adopt BEFORE UPDATE OF file ON videos WHEN NEW.file<>OLD.file BEGIN SELECT RAISE(ABORT,'adopt failure'); END"),dispose:f.dispose};
 }catch(error){await f.dispose();throw error;}
});
