import {describe} from 'vitest';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {users,videos,videoCourses,videoCourseMembers,lmsInstallations,teachingConnections,lmsCourses,lmsResources,externalTasks,ltiCourseTags,ltiCourseVideoTags,mcpIdempotencyRecords,ltiCredentials,ltiMaterialOperations,ltiOperationReservations,jobExecutions} from '../../src/db/schema';
import {isolatedPostgres} from './isolated-postgres';
import {materialManagementContract} from './contracts/material-management.contract';
import {seedHistory} from './contracts/course-history.contract';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL material management',()=>{
 materialManagementContract('PostgreSQL',async()=>{
  const f=await isolatedPostgres(url!),env={DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings;
  const execute=async(sql:string,args:unknown[]=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};
  try{
   const schema={users,videos,videoCourses,videoCourseMembers,lmsInstallations,teachingConnections,lmsCourses,lmsResources,externalTasks,ltiCourseTags,ltiCourseVideoTags,mcpIdempotencyRecords,ltiCredentials,ltiMaterialOperations,ltiOperationReservations,jobExecutions};
   await execute((await generateMigration(generateDrizzleJson({}),generateDrizzleJson(schema))).map(s=>s.replaceAll('"public".','')).join('\n'));
   await execute('CREATE TABLE scene_embeddings(video_id bigint); CREATE TABLE mutation_receipts(token text)');const seeded=await seedHistory(env,execute);
   return {env,execute,...seeded,dispose:f.dispose,
    count:async(table:'lti_material_operations'|'lti_operation_reservations'|'mutation_receipts')=>Number((await f.pool.query<{n:string}>(`SELECT count(*) AS n FROM ${table}`)).rows[0].n),
    tasks:async()=>(await f.pool.query<{id:number;payload:{message:unknown}}>("SELECT id,payload FROM external_tasks WHERE kind='sqs_job' ORDER BY id")).rows.map(r=>({...r,id:Number(r.id)})),
    failReceipt:()=>execute("CREATE FUNCTION receipt_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt failure'; END $$; CREATE TRIGGER fail_material BEFORE INSERT ON lti_material_operations FOR EACH ROW EXECUTE FUNCTION receipt_fail()")};
  }catch(error){await f.dispose();throw error;}
 });
});
