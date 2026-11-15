import { createD1Fixture } from "./d1-fixture";
import { processingQuotaContract } from "./contracts/processing-quota.contract";
import { createD1ProcessingQuotaRepository } from "../../src/persistence/d1/processing-quota";
processingQuotaContract("D1 workerd", async () => {
  const f = await createD1Fixture();
  const execute = async (sql: string, args: unknown[] = []) => { await f.database.prepare(sql).bind(...args).run(); };
  await execute(`INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,processing_limit_minutes,usage_period_start)
    VALUES ('owner','owner','owner@example.test',0,7,0,0,1,?)`, [new Date().toISOString()]);
  for (let id = 1; id <= 8; id++) await execute(`INSERT INTO videos(id,user_id,title,file,description,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id)
    VALUES (?,'owner','video','file','','2026-11-13T00:00:00Z','','processing','','uploaded','','')`, [id]);
  return {
    repository: createD1ProcessingQuotaRepository(f.database), execute, dispose: f.dispose,
    used: async () => {
      const row = await f.database.prepare("SELECT used_processing_seconds AS seconds,used_ai_answers AS answers FROM users WHERE id='owner'").first<{ seconds: number; answers: number }>();
      return row!;
    },
    failVideoUpdate: async () => { await execute("CREATE TRIGGER reject_video_quota BEFORE UPDATE OF processing_seconds ON videos WHEN NEW.processing_seconds=13 BEGIN SELECT RAISE(ABORT,'injected failure'); END"); },
  };
});
