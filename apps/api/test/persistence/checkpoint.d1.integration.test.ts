import {createD1Fixture} from "./d1-fixture";
import {checkpointContract} from "./contracts/checkpoint.contract";
import {D1CheckpointSaver} from "../../src/persistence/d1/checkpoint-saver";
checkpointContract('D1 workerd',async()=>{
  const f=await createD1Fixture();const threadId='checkpoint-thread';const leaseId=crypto.randomUUID();
  await f.database.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES ('owner','owner','owner@example.test',0,0,0,0)").run();
  await f.database.prepare("INSERT INTO chat_conversations(thread_id,conversation_id,owner_user_id,lease_id,leased_until,expires_at) VALUES (?,?,?,?,'2099-01-01T00:00:00Z','2099-01-01T00:00:00Z')").bind(threadId,crypto.randomUUID(),'owner',leaseId).run();
  return{saver:new D1CheckpointSaver(f.database,{threadId,leaseId}),threadId,dispose:f.dispose};
});
