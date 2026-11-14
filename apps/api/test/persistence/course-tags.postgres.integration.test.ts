import {describe} from 'vitest';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {users,videos,videoCourses,videoCourseMembers,lmsInstallations,teachingConnections,lmsCourses,lmsResources,externalTasks,ltiCourseTags,ltiCourseVideoTags,mcpIdempotencyRecords,ltiCredentials,ltiCourseTagOperations,ltiOperationReservations} from '../../src/db/schema';
import {isolatedPostgres} from './isolated-postgres';
import {courseTagsContract} from './contracts/course-tags.contract';
import {seedHistory} from './contracts/course-history.contract';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL course tags',()=>{
 courseTagsContract('PostgreSQL',async()=>{
  const f=await isolatedPostgres(url!),env={DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings;
  const execute=async(sql:string,args:unknown[]=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};
  try{
   const schema={users,videos,videoCourses,videoCourseMembers,lmsInstallations,teachingConnections,lmsCourses,lmsResources,externalTasks,ltiCourseTags,ltiCourseVideoTags,mcpIdempotencyRecords,ltiCredentials,ltiCourseTagOperations,ltiOperationReservations};
   await execute((await generateMigration(generateDrizzleJson({}),generateDrizzleJson(schema))).map(s=>s.replaceAll('"public".','')).join('\n'));
   await execute('CREATE TABLE scene_embeddings(video_id bigint); CREATE TABLE mutation_receipts(token text)');const seeded=await seedHistory(env,execute);
   return {env,execute,...seeded,dispose:f.dispose,
    count:async(table:'lti_course_tag_operations'|'lti_operation_reservations'|'lti_course_video_tags'|'mutation_receipts')=>Number((await f.pool.query<{n:string}>(`SELECT count(*) AS n FROM ${table}`)).rows[0].n),
    failOperation:()=>execute("CREATE FUNCTION receipt_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt failure'; END $$; CREATE TRIGGER fail_tag_receipt BEFORE INSERT ON lti_course_tag_operations FOR EACH ROW EXECUTE FUNCTION receipt_fail()"),
    seedTags:(count:number)=>execute("INSERT INTO lti_course_tags(id,course_id,name,color,revision) SELECT id,?,name,'gray',revision FROM jsonb_to_recordset(?::jsonb) t(id uuid,revision uuid,name text)",[seeded.courseId,JSON.stringify(Array.from({length:count},(_,i)=>({id:crypto.randomUUID(),revision:crypto.randomUUID(),name:`Tag ${i}`})))])};
  }catch(error){await f.dispose();throw error;}
 });
});
