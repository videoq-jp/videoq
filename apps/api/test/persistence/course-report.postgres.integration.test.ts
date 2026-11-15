import {describe} from 'vitest';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {users,videos,videoCourses,videoCourseMembers,lmsInstallations,teachingConnections,lmsCourses,lmsResources,externalTasks,ltiCourseTags,ltiCourseVideoTags,mcpIdempotencyRecords,ltiCredentials,chatLogs,ltiChatLogSubjects,ltiReportAccesses} from '../../src/db/schema';
import {isolatedPostgres} from './isolated-postgres';
import {courseReportContract} from './contracts/course-report.contract';
import {seedHistory} from './contracts/course-history.contract';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL aggregate reports',()=>{
 courseReportContract('PostgreSQL',async()=>{
  const f=await isolatedPostgres(url!),env={DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings;
  const execute=async(sql:string,args:unknown[]=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};
  try{
   const schema={users,videos,videoCourses,videoCourseMembers,lmsInstallations,teachingConnections,lmsCourses,lmsResources,externalTasks,ltiCourseTags,ltiCourseVideoTags,mcpIdempotencyRecords,ltiCredentials,chatLogs,ltiChatLogSubjects,ltiReportAccesses};
   for(const statement of await generateMigration(generateDrizzleJson({}),generateDrizzleJson(schema)))await execute(statement.replaceAll('"public".',''));
   await execute('CREATE TABLE scene_embeddings(video_id bigint); CREATE TABLE mutation_receipts(token text)');
   return {env,execute,...await seedHistory(env,execute),dispose:f.dispose,
    audits:async()=>(await f.pool.query<{actorKey:string;resourceCount:number;scopeHash:string}>('SELECT actor_key AS "actorKey",resource_count AS "resourceCount",scope_hash AS "scopeHash" FROM lti_report_accesses')).rows,
    failAudit:()=>execute("CREATE FUNCTION audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit failure'; END $$; CREATE TRIGGER reject_audit BEFORE INSERT ON lti_report_accesses FOR EACH ROW EXECUTE FUNCTION audit_fail()")};
  }catch(error){await f.dispose();throw error;}
 });
});
