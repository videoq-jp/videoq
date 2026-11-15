import { createD1ExternalTaskRepository } from "../../src/persistence/d1/external-task-repository";
import { externalTaskContract } from "./contracts/external-task.contract";
import { createD1Fixture } from "./d1-fixture";

externalTaskContract("D1 (workerd)", async () => {
  const { database, dispose } = await createD1Fixture();
  return {
    repository: createD1ExternalTaskRepository(database),
    expireAndReady: async id => { await database.prepare("UPDATE external_tasks SET locked_at='2000-01-01T00:00:00.000Z',available_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(id).run(); },
    setAttempts: async (id, attempts) => { await database.prepare("UPDATE external_tasks SET attempts=? WHERE id=?").bind(attempts, id).run(); },
    createCleanup: async (effectApplied = false) => {
      await database.prepare(`INSERT INTO users(id,username,email,is_over_quota,used_storage_bytes,storage_limit_gb,used_ai_answers,used_processing_seconds)
        VALUES ('owner','owner','owner@example.test',1,10,?,0,0)`).bind(5 / 1024 ** 3).run();
      const task = await database.prepare(`INSERT INTO external_tasks(kind,payload,dedupe_key,effect_applied_at)
        VALUES ('storage_cleanup','{}','storage:owner',?) RETURNING id`).bind(effectApplied ? "2000-01-01T00:00:00.000Z" : null).first<{ id: number }>();
      return task!.id;
    },
    rejectCompletion: async () => { await database.prepare("CREATE TRIGGER reject_complete BEFORE UPDATE ON external_tasks WHEN NEW.completed_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'test completion rejection'); END").run(); },
    seedHistory: async () => {
      await database.prepare(`INSERT INTO job_executions(job_id,job_type,payload_sha256,status,completed_at)
        VALUES ('free','transcribe',?,'completed','2000-01-01T00:00:00.000Z'),('protected','transcribe',?,'completed','2000-01-01T00:00:00.000Z')`).bind("a".repeat(64), "a".repeat(64)).run();
      await database.prepare(`INSERT INTO external_tasks(kind,payload,dedupe_key,completed_at) VALUES
        ('sqs_job','{"message":{"job_id":"free"}}','free','2000-01-01T00:00:00.000Z'),
        ('sqs_job','{"message":{"job_id":"protected"}}','protected',NULL)`).run();
    },
    snapshot: async () => {
      const user = await database.prepare("SELECT used_storage_bytes,is_over_quota FROM users WHERE id='owner'").first<{ used_storage_bytes: number; is_over_quota: number }>();
      return { storageBytes: user?.used_storage_bytes ?? 0, overQuota: Boolean(user?.is_over_quota),
        receipts: await database.prepare("SELECT count(*) AS count FROM mutation_receipts").first<number>("count") ?? 0,
        completed: await database.prepare("SELECT count(*) AS count FROM external_tasks WHERE completed_at IS NOT NULL").first<number>("count") ?? 0,
        protectedJob: Boolean(await database.prepare("SELECT job_id FROM job_executions WHERE job_id='protected'").first()),
      };
    },
    dispose,
  };
});
