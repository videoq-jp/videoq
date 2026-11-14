import { createD1VideoUploadRepository } from "../../src/persistence/d1/video-upload-repository";
import { createD1Fixture } from "./d1-fixture";
import { videoUploadContract } from "./contracts/video-upload.contract";

videoUploadContract("D1 (workerd)", async () => {
  const { database, dispose } = await createD1Fixture();
  await database.prepare("CREATE TRIGGER reject_video BEFORE INSERT ON videos WHEN NEW.title='reject' BEGIN SELECT RAISE(ABORT,'test rejection'); END").run();
  return {
    repository: createD1VideoUploadRepository(database),
    seedOwner: async (options = {}) => {
      await database.prepare(`INSERT INTO users
        (id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,
         storage_limit_gb,monthly_upload_limit_gb,used_upload_bytes,upload_usage_period_start)
        VALUES ('owner','owner','owner@example.test',0,0,0,0,?,?,?,?)`)
        .bind(options.storageLimit === null ? null : (options.storageLimit ?? 100) / 1024 ** 3,
          options.monthlyLimit === null ? null : (options.monthlyLimit ?? 100) / 1024 ** 3,
          options.staleMonth ? 1000 : 0, options.staleMonth ? "2000-01-01T00:00:00.000Z" : new Date().toISOString()).run();
    },
    blockOwner: async () => { await database.prepare("UPDATE users SET is_over_quota=1 WHERE id='owner'").run(); },
    failOutbox: async () => { await database.prepare("CREATE TRIGGER reject_outbox BEFORE INSERT ON external_tasks BEGIN SELECT RAISE(ABORT,'test outbox rejection'); END").run(); },
    snapshot: async () => {
      const user = await database.prepare("SELECT used_storage_bytes,used_upload_bytes FROM users WHERE id='owner'").first<{ used_storage_bytes: number; used_upload_bytes: number }>();
      const videos = (await database.prepare("SELECT id,status FROM videos ORDER BY id").all<{ id: number; status: string }>()).results;
      const tasks = (await database.prepare("SELECT id,payload FROM external_tasks ORDER BY id").all<{ id: number; payload: string }>()).results;
      return { storageBytes: user?.used_storage_bytes ?? 0, uploadBytes: user?.used_upload_bytes ?? 0, videos,
        tasks: tasks.map(task => { const { message } = JSON.parse(task.payload); return { id: task.id, videoId: message.payload.video_id as number, jobId: message.job_id as string }; }),
        receiptCount: await database.prepare("SELECT count(*) AS count FROM mcp_idempotency_records").first<number>("count") ?? 0 };
    },
    dispose,
  };
});
