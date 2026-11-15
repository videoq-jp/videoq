import {createD1Fixture} from './d1-fixture';
import {seedSyncOwner} from './contracts/lms-resource-sync.contract';
import {materialsSyncContract} from './contracts/materials-sync.contract';
import type {Bindings} from '../../src/types/bindings';
materialsSyncContract('D1 workerd',async()=>{
 const f=await createD1Fixture(),execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args).run();};
 try{await seedSyncOwner(execute);return {env:{DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings,execute,
  state:async(id:string)=>{const row=await f.database.prepare('SELECT payload,expires_at AS expiresAt FROM lti_credentials WHERE id=?').bind(id).first<{payload:string;expiresAt:string}>();return row?{...row,payload:JSON.parse(row.payload) as Record<string,unknown>}:null;},
  taskCount:async()=>Number(await f.database.prepare("SELECT count(*) AS n FROM external_tasks WHERE kind='sqs_job'").first('n')),
  cursor:async()=>Number(await f.database.prepare('SELECT materials_cursor FROM lms_installations').first('materials_cursor')),dispose:f.dispose};
 }catch(error){await f.dispose();throw error;}
});
