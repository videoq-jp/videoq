import {createD1Fixture} from "./d1-fixture";
import {createD1ReindexRepository} from "../../src/persistence/d1/reindex-repository";
import {reindexContract} from "./contracts/reindex.contract";
reindexContract('D1 workerd',async()=>{
  const f=await createD1Fixture();
  await f.database.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES ('owner','owner','owner@example.test',0,0,0,0)").run();
  for (let id=1;id<=35;id++) await f.database.prepare(`INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id)
    VALUES (?,'owner','Video','file.mp4',?,?,'','2026-11-13T00:00:00Z','','uploaded','','')`)
    .bind(id,({4:'processing',6:'error',8:'indexing',10:'uploading'} as Record<number,string>)[id]??'completed',id===2?'':id===1?' ':'caption').run();
  return {repository:createD1ReindexRepository(f.database),remove:async id=>{await f.database.prepare('DELETE FROM videos WHERE id=?').bind(id).run();},dispose:f.dispose};
});
