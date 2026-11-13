import {describe} from 'vitest';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {users,videos,videoCourses,videoCourseMembers,lmsInstallations,teachingConnections,lmsCourses,lmsResources,externalTasks,ltiCourseTags,ltiCourseVideoTags,mcpIdempotencyRecords,ltiCredentials,ltiReportAccesses,ltiMaterialOperations,ltiCourseTagOperations,ltiOperationReservations,courseQaModeration,courseQuestions} from '../../src/db/schema';
import {isolatedPostgres} from './isolated-postgres';
import {auditRetentionContract,type AuditTable} from './contracts/audit-retention.contract';
import {seedHistory} from './contracts/course-history.contract';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL audit retention',()=>{
 auditRetentionContract('PostgreSQL',async()=>{
  const f=await isolatedPostgres(url!),env={DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings;
  const execute=async(sql:string,args:unknown[]=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};
  try{
   const schema={users,videos,videoCourses,videoCourseMembers,lmsInstallations,teachingConnections,lmsCourses,lmsResources,externalTasks,ltiCourseTags,ltiCourseVideoTags,mcpIdempotencyRecords,ltiCredentials,ltiReportAccesses,ltiMaterialOperations,ltiCourseTagOperations,ltiOperationReservations,courseQaModeration,courseQuestions};
   const statements=await generateMigration(generateDrizzleJson({}),generateDrizzleJson(schema));
   await execute(statements.map(statement=>statement.replaceAll('"public".','')).join("\n"));
   await execute('CREATE TABLE scene_embeddings(video_id bigint); CREATE TABLE mutation_receipts(token text)');const seeded=await seedHistory(env,execute);
   return {env,execute,...seeded,dispose:f.dispose,
    rows:async(table:AuditTable)=>(await f.pool.query<Record<string,unknown>>(`SELECT * FROM ${table}`)).rows,
    failDelete:()=>execute("CREATE FUNCTION audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit delete failure'; END $$; CREATE TRIGGER reject_audit_delete BEFORE DELETE ON lti_course_tag_operations FOR EACH ROW EXECUTE FUNCTION audit_fail()"),
    seedBacklog:(count:number,at:string)=>execute("INSERT INTO lti_course_tag_operations(id,course_id,actor_key,action,request_hash,created_at) SELECT value::uuid,?,?,'create',?,?::timestamptz FROM jsonb_array_elements_text(?::jsonb)",[seeded.courseId,'e'.repeat(64),'a'.repeat(64),at,JSON.stringify(Array.from({length:count},()=>crypto.randomUUID()))])};
  }catch(error){await f.dispose();throw error;}
 });
});
