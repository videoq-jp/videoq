import {describe} from 'vitest';
import {isolatedPostgres} from './isolated-postgres';
import {courseContract,seedCourses} from './contracts/course.contract';
import {createCourseRepository} from '../../src/persistence/factory';
import {visualSchema} from '../helpers/visual-schema';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL course',()=>{
  courseContract('PostgreSQL',async()=>{
    const f=await isolatedPostgres(url!);
    const execute=async(sql:string,args:unknown[]=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};
    try {
    await execute(`CREATE TABLE users(id text PRIMARY KEY);
      CREATE TABLE videos(id bigint PRIMARY KEY,user_id text,title text,description text,file text,uploaded_at timestamptz,status text,source_type text,source_url text,youtube_video_id text,managed_by_lms boolean DEFAULT false,transcript text,error_message text);
      CREATE TABLE video_courses(id bigserial PRIMARY KEY,user_id text REFERENCES users,name text,description text,display_order integer,share_slug text,created_at timestamptz,updated_at timestamptz,managed_by_lms boolean DEFAULT false,native_access_disabled boolean DEFAULT false);
      CREATE UNIQUE INDEX video_courses_share_slug_ci_uniq ON video_courses(lower(share_slug)) WHERE share_slug IS NOT NULL;
      CREATE TABLE video_course_members(id bigserial PRIMARY KEY,course_id bigint REFERENCES video_courses ON DELETE CASCADE,video_id bigint REFERENCES videos,"order" integer,added_at timestamptz,UNIQUE(course_id,video_id));
      CREATE TABLE video_course_memberships(course_id bigint REFERENCES video_courses ON DELETE CASCADE,user_id text,joined_at timestamptz);
      CREATE TABLE tags(id bigint PRIMARY KEY,user_id text,name text,color text,created_at timestamptz);
      CREATE TABLE video_tags(id bigserial PRIMARY KEY,video_id bigint REFERENCES videos,tag_id bigint REFERENCES tags,added_at timestamptz);
      CREATE TABLE mcp_idempotency_records(user_id text,action text,key text,request_hash text,resource_id bigint,created_at timestamptz DEFAULT now(),PRIMARY KEY(user_id,action,key));
      CREATE TABLE chat_logs(id bigint PRIMARY KEY,course_id bigint REFERENCES video_courses ON DELETE CASCADE,user_id text,question text,response jsonb,retrieved_contexts jsonb,is_shared_origin boolean,created_at timestamptz);
      CREATE TABLE chat_conversations(thread_id text PRIMARY KEY,conversation_id uuid,owner_user_id text,actor_user_id text,course_id bigint REFERENCES video_courses ON DELETE CASCADE,expires_at timestamptz);
      CREATE TABLE chat_conversation_turns(id bigserial PRIMARY KEY,thread_id text REFERENCES chat_conversations ON DELETE CASCADE,checkpoint_id text,question text,response jsonb,chat_log_id bigint REFERENCES chat_logs ON DELETE SET NULL);
      ${visualSchema}`);
    await seedCourses(execute);await execute("SELECT setval(pg_get_serial_sequence('video_courses','id'),100)");
    return {repository:await createCourseRepository({DATABASE_POOL:f.pool,USE_S3_STORAGE:'false'} as Bindings),execute,
      count:async(table:string)=>Number((await f.pool.query<{n:string}>(`SELECT count(*) AS n FROM ${table}`)).rows[0].n),
      failCreate:()=>execute("ALTER TABLE mcp_idempotency_records ADD CONSTRAINT fail_create CHECK(false)"),
      failDelete:()=>execute("CREATE FUNCTION fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected deletion'; END $$; CREATE TRIGGER fail_delete BEFORE DELETE ON video_courses FOR EACH ROW EXECUTE FUNCTION fail_delete()"),dispose:f.dispose};
    }catch(error){await f.dispose();throw error;}
  });
});
