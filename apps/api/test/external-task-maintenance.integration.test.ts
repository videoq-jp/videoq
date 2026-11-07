import { nativeCourseAuthorityFixture } from './helpers/native-course-authority-fixture';
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimExternalTasks,
  completeExternalTask,
  completeStorageCleanupTask,
  failExternalTask,
  getExternalTaskHealth,
  pruneDeliveryHistory,
} from "../src/repositories/external-task-repository";
import { recordInvitationDeliveryOutcomes, rotateInvitationTokenForDelivery } from "../src/repositories/course-invitation-repository";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
type TaskEnv = Parameters<typeof claimExternalTasks>[0];

describeWithPostgres("external task maintenance on PostgreSQL", () => {
  const schemaName = `external_tasks_${crypto.randomUUID().replaceAll("-", "")}`;
  const quotedSchema = `"${schemaName}"`;
  let admin: pg.Client;
  let env: TaskEnv;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quotedSchema}`);
    await admin.query(`
      CREATE TABLE ${quotedSchema}.external_tasks (
        id bigserial PRIMARY KEY,
        kind varchar(32) NOT NULL,
        payload jsonb NOT NULL,
        dedupe_key varchar(255) NOT NULL UNIQUE,
        attempts integer NOT NULL DEFAULT 0,
        available_at timestamptz NOT NULL DEFAULT now(),
        locked_at timestamptz,
        completed_at timestamptz,
        dead_at timestamptz,
        effect_applied_at timestamptz,
        last_error text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await admin.query(`
      CREATE TABLE ${quotedSchema}.job_executions (
        job_id varchar(128) PRIMARY KEY,
        completed_at timestamptz
      )
    `);
    await admin.query(`
      CREATE TABLE ${quotedSchema}.users (
        id text PRIMARY KEY, name text, username text,
        used_storage_bytes bigint, storage_limit_gb numeric, is_over_quota boolean
      );
      CREATE TABLE ${quotedSchema}.video_courses (id integer PRIMARY KEY, name text);
      CREATE TABLE ${quotedSchema}.video_course_invitations (
        id integer PRIMARY KEY, email text, status text, expires_at timestamptz,
        course_id integer, invited_by_user_id text, token_hash text, updated_at timestamptz,
        delivery_status text, last_sent_at timestamptz, last_error text, send_attempts integer DEFAULT 0
      );
      INSERT INTO ${quotedSchema}.users VALUES ('owner', 'Teacher', 'teacher', 100, 1, false);
      INSERT INTO ${quotedSchema}.video_courses VALUES (1, 'Course');
      INSERT INTO ${quotedSchema}.video_course_invitations
        (id, email, status, expires_at, course_id, invited_by_user_id, token_hash, delivery_status)
      VALUES (1, 'student@example.test', 'pending', now() + interval '1 day', 1, 'owner', 'original', 'queued');
    `);
    const scopedUrl = new URL(databaseUrl!);
    scopedUrl.searchParams.set("options", `-c search_path=${schemaName}`);
    env = { HYPERDRIVE: { connectionString: scopedUrl.toString() } } as TaskEnv;
  });

  nativeCourseAuthorityFixture(() => env);
  afterAll(async () => {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    } finally {
      await admin.end();
    }
  });

  it("同じtaskを並列claimしても一つだけが所有する", async () => {
    const inserted = await admin.query<{ id: string }>(`
      INSERT INTO ${quotedSchema}.external_tasks (kind, payload, dedupe_key)
      VALUES ('sqs_job', '{"message": {}}', 'parallel')
      RETURNING id
    `);
    const taskId = Number(inserted.rows[0].id);
    const claims = await Promise.all(
      Array.from({ length: 10 }, () =>
        claimExternalTasks(env, { limit: 1, taskId }),
      ),
    );

    expect(claims.flat()).toHaveLength(1);
  });

  it("48回失敗したtaskをdeadにして通常claimから除外する", async () => {
    const inserted = await admin.query<{ id: string }>(`
      INSERT INTO ${quotedSchema}.external_tasks
        (kind, payload, dedupe_key, attempts, locked_at)
      VALUES ('sqs_job', '{"message": {}}', 'dead', 48, now())
      RETURNING id
    `);
    const taskId = Number(inserted.rows[0].id);

    await expect(failExternalTask(env, { id: taskId, attempt: 48 }, "poison")).resolves.toEqual({
      dead: true,
      leaseLost: false,
    });
    await expect(claimExternalTasks(env, { limit: 1, taskId })).resolves.toEqual([]);
    await expect(getExternalTaskHealth(env)).resolves.toMatchObject({ dead: 1 });
  });

  it("an expired claimant cannot complete, fail or apply effects after another claim", async () => {
    const inserted = await admin.query<{ id: string }>(`
      INSERT INTO ${quotedSchema}.external_tasks (kind, payload, dedupe_key)
      VALUES ('sqs_job', '{}', 'reclaimed') RETURNING id
    `);
    const taskId = Number(inserted.rows[0].id);
    const [oldLease] = await claimExternalTasks(env, { limit: 1, taskId });
    await admin.query(`UPDATE ${quotedSchema}.external_tasks SET locked_at = now() - interval '6 minutes' WHERE id = $1`, [taskId]);
    // Expiration itself invalidates the old lease, even before another claimant arrives.
    await expect(completeExternalTask(env, oldLease)).rejects.toThrow("lease");
    const [newLease] = await claimExternalTasks(env, { limit: 1, taskId });
    expect(newLease.attempt).toBe(oldLease.attempt + 1);

    await expect(completeExternalTask(env, oldLease)).rejects.toThrow("lease");
    await expect(failExternalTask(env, oldLease, "late failure")).resolves.toEqual({ dead: false, leaseLost: true });
    await expect(completeStorageCleanupTask(env, { lease: oldLease, userId: "owner", bytes: 10 })).rejects.toThrow("lease");
    await expect(rotateInvitationTokenForDelivery(env, 1, "stale-token", new Date(), oldLease)).rejects.toThrow("lease");
    for (const status of ["sent", "failed"] as const) {
      await expect(recordInvitationDeliveryOutcomes(env,
        [{ invitationId: 1, status, attemptedAt: new Date() }],
        { lease: oldLease, completeTask: status === "sent" },
      )).rejects.toThrow("lease");
    }
    const state = await admin.query(`SELECT attempts, completed_at, locked_at, last_error FROM ${quotedSchema}.external_tasks WHERE id = $1`, [taskId]);
    expect(state.rows[0]).toMatchObject({ attempts: newLease.attempt, completed_at: null, last_error: "" });
    expect(state.rows[0].locked_at).not.toBeNull();
    await expect(completeExternalTask(env, newLease)).resolves.toBeUndefined();
  });

  it("a recovery run excludes its own failed tasks even when they become due again", async () => {
    const inserted = await admin.query<{ id: string }>(`
      INSERT INTO ${quotedSchema}.external_tasks (kind, payload, dedupe_key)
      VALUES ('sqs_job', '{}', 'exclude-retry') RETURNING id
    `);
    const taskId = Number(inserted.rows[0].id);
    const [lease] = await claimExternalTasks(env, { limit: 1, taskId });
    await failExternalTask(env, lease, "retry");
    // Simulate a slow run: its failed delivery is already due again.
    await admin.query(`UPDATE ${quotedSchema}.external_tasks SET available_at = now() - interval '1 second' WHERE id = $1`, [taskId]);
    await expect(claimExternalTasks(env, { limit: 1, taskId, excludeTaskIds: [taskId] })).resolves.toEqual([]);
    expect(await claimExternalTasks(env, { limit: 1, taskId })).toHaveLength(1);
  });

  it("the current owner applies storage accounting exactly once", async () => {
    const inserted = await admin.query<{ id: string }>(`
      INSERT INTO ${quotedSchema}.external_tasks (kind, payload, dedupe_key)
      VALUES ('storage_cleanup', '{}', 'storage-effect') RETURNING id
    `);
    const [lease] = await claimExternalTasks(env, { limit: 1, taskId: Number(inserted.rows[0].id) });
    const cleanup = { lease, userId: "owner", bytes: 25 };
    await completeStorageCleanupTask(env, cleanup);
    await expect(completeStorageCleanupTask(env, cleanup)).rejects.toThrow("lease");
    const user = await admin.query(`SELECT used_storage_bytes FROM ${quotedSchema}.users WHERE id = 'owner'`);
    expect(Number(user.rows[0].used_storage_bytes)).toBe(75);
  });

  it("the current owner records invitation delivery and completion atomically", async () => {
    const inserted = await admin.query<{ id: string }>(`
      INSERT INTO ${quotedSchema}.external_tasks (kind, payload, dedupe_key)
      VALUES ('invitation_email', '{}', 'invitation-effect') RETURNING id
    `);
    const taskId = Number(inserted.rows[0].id);
    const [lease] = await claimExternalTasks(env, { limit: 1, taskId });
    const now = new Date();
    await expect(rotateInvitationTokenForDelivery(env, 1, "fresh-token", now, lease)).resolves.toMatchObject({ email: "student@example.test" });
    await recordInvitationDeliveryOutcomes(env, [{ invitationId: 1, status: "sent", attemptedAt: now }], { lease, completeTask: true });
    await expect(recordInvitationDeliveryOutcomes(env, [{ invitationId: 1, status: "failed", attemptedAt: now }], { lease })).rejects.toThrow("lease");
    const invitation = await admin.query(`SELECT delivery_status, send_attempts, token_hash FROM ${quotedSchema}.video_course_invitations WHERE id = 1`);
    expect(invitation.rows[0]).toEqual({ delivery_status: "sent", send_attempts: 1, token_hash: "fresh-token" });
    const task = await admin.query(`SELECT completed_at, locked_at FROM ${quotedSchema}.external_tasks WHERE id = $1`, [taskId]);
    expect(task.rows[0].completed_at).not.toBeNull();
    expect(task.rows[0].locked_at).toBeNull();
  });

  it("30日を超えた完了履歴だけを削除する", async () => {
    await admin.query(`
      INSERT INTO ${quotedSchema}.external_tasks
        (kind, payload, dedupe_key, completed_at)
      VALUES ('sqs_job', '{}', 'old-completed', now() - interval '31 days'),
             ('sqs_job', '{}', 'recent-completed', now())
    `);
    await admin.query(`
      INSERT INTO ${quotedSchema}.job_executions (job_id, completed_at)
      VALUES ('old-job', now() - interval '31 days'),
             ('recent-job', now()),
             ('referenced-job', now() - interval '31 days')
    `);
    await admin.query(`
      INSERT INTO ${quotedSchema}.external_tasks
        (kind, payload, dedupe_key, dead_at)
      VALUES (
        'sqs_job',
        '{"message": {"job_id": "referenced-job"}}',
        'dead-with-ledger',
        now()
      )
    `);

    await expect(pruneDeliveryHistory(env)).resolves.toEqual({
      externalTasks: 1,
      jobExecutions: 1,
    });
    const referenced = await admin.query(`
      SELECT 1
        FROM ${quotedSchema}.job_executions
       WHERE job_id = 'referenced-job'
    `);
    expect(referenced.rowCount).toBe(1);
  });
});
