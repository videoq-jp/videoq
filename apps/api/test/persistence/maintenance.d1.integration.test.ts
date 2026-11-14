import { expect, it } from "vitest";
import { createD1Fixture } from "./d1-fixture";
import { createD1MaintenanceRepository } from "../../src/persistence/d1/maintenance-repository";

it("derives D1 recovery deadlines from task leases and upload heartbeats", async () => {
  const { database, dispose } = await createD1Fixture();
  const repo = createD1MaintenanceRepository(database, false);
  const windows = { leaseMs: 300_000, abandonedUploadMs: 3_600_000, staleInvitationMs: 60_000 };
  try {
    expect(await repo.getNextWakeup(windows)).toEqual({ nextAt: null, nextFutureAt: null });
    await database.prepare(`INSERT INTO external_tasks(kind,payload,dedupe_key,available_at)
      VALUES ('sqs_job','{}','task','2030-01-01T00:00:00.000Z')`).run();
    expect(await repo.getNextWakeup(windows)).toEqual({ nextAt: new Date("2030-01-01"), nextFutureAt: new Date("2030-01-01") });
    const lockedAt = new Date();
    await database.prepare("UPDATE external_tasks SET locked_at=?").bind(lockedAt.toISOString()).run();
    const claimed = await repo.getNextWakeup(windows);
    expect(Math.abs(claimed.nextAt!.getTime() - lockedAt.getTime() - windows.leaseMs)).toBeLessThan(2);
    await database.prepare("UPDATE external_tasks SET locked_at=NULL").run();
    await database.prepare(`INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes)
      VALUES ('owner','owner','owner@example.test',0,0,0,0)`).run();
    await database.prepare(`INSERT INTO videos(user_id,file,title,description,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id)
      VALUES ('owner','','Upload','','2000-01-01T00:00:00.000Z','','uploading','','uploaded','','')`).run();
    expect(await repo.getNextWakeup(windows)).toEqual({ nextAt: new Date("2000-01-01T01:00:00Z"), nextFutureAt: new Date("2030-01-01") });
    await database.prepare("UPDATE videos SET upload_heartbeat_at='2031-01-01T00:00:00.000Z'").run();
    expect((await repo.getNextWakeup(windows)).nextAt).toEqual(new Date("2030-01-01"));
  } finally { await dispose(); }
}, 20_000);

it("schedules active materials polling independently of installer state", async () => {
  const { database, dispose } = await createD1Fixture();
  const windows = { leaseMs: 300_000, abandonedUploadMs: 3_600_000, staleInvitationMs: 60_000 };
  try {
    await database.prepare(`INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes)
      VALUES ('owner','owner','owner@example.test',0,0,0,0)`).run();
    await database.prepare(`INSERT INTO lms_installations(id,owner_user_id,name,issuer,client_id,deployment_id,authorization_url,jwks_url,materials_service,next_materials_sync_at)
      VALUES ('installation','owner','LMS','https://lms.example','client','1','https://lms.example/auth','https://lms.example/jwks','{}','2030-01-01T00:00:00.000Z')`).run();
    expect((await createD1MaintenanceRepository(database, false).getNextWakeup(windows)).nextAt).toBeNull();
    expect((await createD1MaintenanceRepository(database, true).getNextWakeup(windows)).nextAt).toEqual(new Date("2030-01-01"));
    await database.prepare("UPDATE users SET banned=1 WHERE id='owner'").run();
    expect((await createD1MaintenanceRepository(database, true).getNextWakeup(windows)).nextAt).toEqual(new Date("2030-01-01"));
    await database.prepare("UPDATE lms_installations SET active=0").run();
    expect((await createD1MaintenanceRepository(database, true).getNextWakeup(windows)).nextAt).toBeNull();
  } finally { await dispose(); }
}, 20_000);
