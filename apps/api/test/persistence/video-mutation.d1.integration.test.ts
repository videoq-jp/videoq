import { createD1VideoMutationRepository } from "../../src/persistence/d1/video-mutation-repository";
import { createD1VideoUploadRepository } from "../../src/persistence/d1/video-upload-repository";
import { buildPendingUploadFileKey } from "../../src/lib/upload";
import { createD1Fixture } from "./d1-fixture";
import { videoMutationContract } from "./contracts/video-mutation.contract";

videoMutationContract("D1 (workerd)", async () => {
  const { database, dispose } = await createD1Fixture();
  return {
    repository: createD1VideoMutationRepository(database),
    seed: async (status = "completed", staleUploadPeriod = false) => {
      await database.prepare(`INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes)
        VALUES ('owner','owner','owner@example.test',0,0,0,0)`).run();
      const uploaded = await createD1VideoUploadRepository(database).reserveUpload({ userId: "owner", storageBytes: 5, fileKey: buildPendingUploadFileKey("owner", 5, ".mp4"), title: "Lesson", description: "" });
      if (!("ok" in uploaded)) throw new Error("Fixture upload failed");
      await database.prepare("UPDATE videos SET status=?,transcript='Original' WHERE id=?").bind(status, uploaded.videoId).run();
      if (staleUploadPeriod) await database.prepare("UPDATE videos SET upload_usage_period_start='2000-01-01T00:00:00.000Z'").run();
      await database.prepare(`INSERT INTO scenes(id,video_id,content,start_time,end_time,dimensions,revision)
        VALUES ('legacy',?,'Original','00:01','00:02',1536,'legacy')`).bind(uploaded.videoId).run();
      return uploaded.videoId;
    },
    rejectOutbox: async () => { await database.prepare("CREATE TRIGGER reject_outbox BEFORE INSERT ON external_tasks BEGIN SELECT RAISE(ABORT,'test outbox failure'); END").run(); },
    snapshot: async () => {
      const counts = await database.prepare(`SELECT (SELECT count(*) FROM videos) AS videos,(SELECT count(*) FROM scenes) AS scenes,
        (SELECT count(*) FROM external_tasks) AS externalTasks,(SELECT count(*) FROM mutation_receipts) AS receipts,
        used_upload_bytes AS uploadBytes,used_storage_bytes AS storageBytes FROM users WHERE id='owner'`)
        .first<{ videos: number; scenes: number; externalTasks: number; receipts: number; uploadBytes: number; storageBytes: number }>();
      return counts!;
    },
    dispose,
  };
});
