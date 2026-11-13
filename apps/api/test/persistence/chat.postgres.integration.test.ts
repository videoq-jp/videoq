import {describe} from "vitest";
import {isolatedPostgres} from "./isolated-postgres";
import {chatContract} from "./contracts/chat.contract";
import {createChatRepository} from "../../src/persistence/factory";
import type {Bindings} from "../../src/types/bindings";
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL chat contract',()=>{
  chatContract('postgres',async()=>{
    const f=await isolatedPostgres(url!);
    const execute=async(sql:string,args:unknown[]=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};
    await execute(`CREATE TABLE users(id text PRIMARY KEY,username text,email text,is_active boolean DEFAULT true,deactivated_at timestamptz,banned boolean DEFAULT false,ban_expires timestamptz);
      CREATE TABLE videos(id integer PRIMARY KEY,managed_by_lms boolean DEFAULT false);
      CREATE TABLE video_courses(id integer PRIMARY KEY,user_id text REFERENCES users,share_slug text,managed_by_lms boolean DEFAULT false,native_access_disabled boolean DEFAULT false);
      CREATE TABLE video_course_members(id serial PRIMARY KEY,course_id integer REFERENCES video_courses,video_id integer REFERENCES videos,"order" integer);
      CREATE TABLE video_course_memberships(course_id integer,user_id text);
      CREATE TABLE chat_logs(id serial PRIMARY KEY,user_id text REFERENCES users,course_id integer REFERENCES video_courses ON DELETE CASCADE,question text,response jsonb,retrieved_contexts jsonb,is_shared_origin boolean,feedback text,created_at timestamptz);
      CREATE TABLE lti_credentials(id text PRIMARY KEY,kind text,payload jsonb,expires_at timestamptz);
      CREATE TABLE lti_chat_log_subjects(chat_log_id integer PRIMARY KEY REFERENCES chat_logs ON DELETE CASCADE,subject_key text,resource_video_ids jsonb,registration_id text,context_id text,classroom_author jsonb);
      CREATE TABLE chat_conversations(thread_id text PRIMARY KEY,conversation_id text,owner_user_id text,course_id integer,expires_at timestamptz);`);
    for (const id of ['owner','learner','outsider']) await execute('INSERT INTO users(id,username,email) VALUES (?,?,?)',[id,id,`${id}@example.test`]);
    await execute("INSERT INTO video_courses(id,user_id,share_slug) VALUES (1,'owner','public'); INSERT INTO videos(id) VALUES (1),(2); INSERT INTO video_course_members(course_id,video_id,\"order\") VALUES (1,2,0),(1,1,1); INSERT INTO video_course_memberships VALUES (1,'learner')");
    return {repository:await createChatRepository({DATABASE_POOL:f.pool} as Bindings),execute,
      subject:async()=>{const row=(await f.pool.query<{subjectKey:string;resourceVideoIds:number[];registrationId:string|null;contextId:string|null}>('SELECT subject_key AS "subjectKey",resource_video_ids AS "resourceVideoIds",registration_id AS "registrationId",context_id AS "contextId" FROM lti_chat_log_subjects')).rows[0];return row??null;},
      failAttribution:()=>execute('ALTER TABLE lti_chat_log_subjects ADD CONSTRAINT injected_failure CHECK(false)'),
      failHistoryDelete:()=>execute("CREATE FUNCTION reject_chat_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$; CREATE TRIGGER reject_chat_delete BEFORE DELETE ON chat_logs FOR EACH ROW EXECUTE FUNCTION reject_chat_delete()"),
      count:async table=>Number((await f.pool.query<{n:string}>(`SELECT count(*) AS n FROM ${table}`)).rows[0].n),dispose:f.dispose};
  });
});
