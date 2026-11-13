import {createD1Fixture} from './d1-fixture';
import {membershipContract} from './contracts/membership.contract';
import {createMembershipRepository} from '../../src/persistence/factory';
import type {Bindings} from '../../src/types/bindings';
membershipContract('D1 workerd',async()=>{
  const f=await createD1Fixture();const execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args).run();};
  for(const id of ['owner','other'])await execute('INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,0,0,0,0)',[id,id,`${id}@example.test`]);
  for(const id of [1,2,3,4,5,6])await execute("INSERT INTO videos(id,user_id,managed_by_lms,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES (?,?,?,'Video','file.mp4','completed','','','2026-11-13T00:00:00Z','','uploaded','','')",[id,id===3?'other':'owner',id===4?1:0]);
  for(const id of [1,2,3]){
    await execute("INSERT INTO video_courses(id,user_id,managed_by_lms,name,description,created_at,updated_at,display_order) VALUES(?,?,?,'course','','2026-01-01','2026-01-01',0)",[id,id===2?'other':'owner',id===3?1:0]);
    await execute("INSERT INTO tags(id,user_id,name,color,created_at) VALUES(?,?,?,'#123456','2026-01-01')",[id,id===2?'other':'owner',`tag${id}`]);
  }
  return {repository:await createMembershipRepository({DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings),execute,
    members:async()=>(await f.database.prepare('SELECT video_id AS videoId,"order" FROM video_course_members WHERE course_id=1 ORDER BY "order",id').all<{videoId:number;order:number}>()).results,
    tagIds:async()=>(await f.database.prepare('SELECT tag_id AS id FROM video_tags ORDER BY tag_id').all<{id:number}>()).results.map(r=>r.id),
    failBulk:()=>execute("CREATE TRIGGER fail_bulk BEFORE INSERT ON video_course_members WHEN NEW.video_id=2 BEGIN SELECT RAISE(ABORT,'injected bulk failure'); END"),dispose:f.dispose};
});
