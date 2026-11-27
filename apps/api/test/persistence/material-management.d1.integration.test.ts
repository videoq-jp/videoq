import { expect,it } from 'vitest';
import { manageLtiMaterial } from '../../src/features/lti/material-management';
import {createD1Fixture} from './d1-fixture';
import {materialManagementContract,seedMaterial,materialScope} from './contracts/material-management.contract';
import {seedHistory} from './contracts/course-history.contract';
import type {Bindings} from '../../src/types/bindings';
async function setup(){
 const f=await createD1Fixture(),env={DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings;
 const execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args).run();};
 try{const seeded=await seedHistory(env,execute);return {env,execute,...seeded,dispose:f.dispose,
  count:async(table:'lti_material_operations'|'lti_operation_reservations'|'mutation_receipts')=>Number(await f.database.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')),
  tasks:async()=>(await f.database.prepare("SELECT id,payload FROM external_tasks WHERE kind='sqs_job' ORDER BY id").all<{id:number;payload:string}>()).results.map(r=>({...r,payload:JSON.parse(r.payload) as {message:unknown}})),
  failReceipt:()=>execute("CREATE TRIGGER fail_material BEFORE INSERT ON lti_material_operations BEGIN SELECT RAISE(ABORT,'receipt failure'); END")};
 }catch(error){await f.dispose();throw error;}
}
materialManagementContract('D1 workerd',setup);

it('preserves legacy D1 text on read and when updating only another field',async()=>{
 const f=await setup();try {
  await seedMaterial(f);const scope=materialScope(f),legacy='Legacy'+String.fromCharCode(0)+'notes';
  await f.execute('UPDATE videos SET description=? WHERE id=?',[legacy,scope.videoId]);
  const before=await manageLtiMaterial(f.env,scope,{action:'get',videoId:scope.videoId});
  expect(before.material.description).toBe(legacy);
  const transcript='1\n00:00:00,000 --> 00:00:01,000\n  日本語 😀 e\u0301  \n';
  const result=await manageLtiMaterial(f.env,scope,{action:'update',videoId:scope.videoId,operationId:crypto.randomUUID(),revision:before.material.revision,fields:{transcript}});
  expect(result.material).toMatchObject({description:legacy,transcript});
 }finally{await f.dispose();}
});
