import {createD1Fixture} from "./d1-fixture";
import {chatContract} from "./contracts/chat.contract";
import {createChatRepository} from "../../src/persistence/factory";
import type {Bindings} from "../../src/types/bindings";
chatContract('D1 workerd',async()=>{
  const f=await createD1Fixture();
  const execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args).run();};
  for (const id of ['owner','learner','outsider']) await execute("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES (?,?,?,0,0,0,0)",[id,id,`${id}@example.test`]);
  await execute("INSERT INTO video_courses(id,user_id,name,description,created_at,updated_at,display_order,share_slug) VALUES (1,'owner','Course','','2026-11-13T00:00:00Z','2026-11-13T00:00:00Z',0,'public')");
  for (const id of [1,2]) await execute("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES (?,'owner','Video','file.mp4','completed','','','2026-11-13T00:00:00Z','','uploaded','','')",[id]);
  await execute('INSERT INTO video_course_members(course_id,video_id,added_at,"order") VALUES (1,2,?,0),(1,1,?,1)',['2026-11-13T00:00:00Z','2026-11-13T00:00:00Z']);
  await execute("INSERT INTO video_course_memberships(course_id,user_id,joined_at) VALUES (1,'learner','2026-11-13T00:00:00Z')");
  return {repository:await createChatRepository({DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings),execute,
    subject:async()=>{
      const row=await f.database.prepare('SELECT subject_key AS subjectKey,resource_video_ids AS resourceVideoIds,registration_id AS registrationId,context_id AS contextId FROM lti_chat_log_subjects').first<{subjectKey:string;resourceVideoIds:string;registrationId:string|null;contextId:string|null}>();
      return row?{...row,resourceVideoIds:JSON.parse(row.resourceVideoIds) as number[]}:null;
    },
    failAttribution:()=>execute("CREATE TRIGGER reject_attribution BEFORE INSERT ON lti_chat_log_subjects BEGIN SELECT RAISE(ABORT,'injected failure'); END"),
    failHistoryDelete:()=>execute("CREATE TRIGGER reject_chat_delete BEFORE DELETE ON chat_logs BEGIN SELECT RAISE(ABORT,'injected failure'); END"),
    count:async table=>Number(await f.database.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')),dispose:f.dispose};
});
