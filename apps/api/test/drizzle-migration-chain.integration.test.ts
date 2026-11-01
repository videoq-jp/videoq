import { migrateDatabase } from "../scripts/migrate-database";
import { convertHistoricalAnswer } from "../scripts/migrations/structured-answer/convert";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig } from "drizzle-orm/pg-core";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { createAuth } from "../src/lib/auth";
import { patchFlags } from "../src/features/admin/service";
import { getAdminUser, isAdmin } from "../src/repositories/admin-repository";
import { getCurrentUser } from "../src/repositories/user-repository";
import { schema, users, account } from "../src/db/schema";
import type { Bindings } from "../src/types/bindings";
import { purgeRetiredStudyData } from "../scripts/purge-retired-study-data.mjs";

const legacyStudyTables = [
  "app_learnerconceptstate", "app_plogbuildjob", "app_plogconcept",
  "app_plogedge", "app_ploglearningobject", "app_plogsummarynode",
];

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
const migrationDirectory = fileURLToPath(
  new URL("../drizzle", import.meta.url),
);
const journal = JSON.parse(
  readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
) as { entries: { idx: number; tag: string }[] };
const migrationDescribe = databaseUrl ? describe : describe.skip;

migrationDescribe("Drizzle migration chain", () => {
  it.each(["empty", "populated"] as const)("applies migrations to a PostgreSQL database (%s)", async (initialState) => {
    const databaseName = `videoq_drizzle_${crypto.randomUUID().replaceAll("-", "")}`;
    const adminPool = new Pool({ connectionString: databaseUrl });
    // node-postgres requires a Pool error listener; without one, a background
    // error on an idle client crashes the process instead of just being ignored.
    // `DROP DATABASE ... WITH (FORCE)` in the `finally` block below races with our
    // own `pool.end()` above it and can surface exactly such an error here.
    adminPool.on("error", () => {});
    const adminDb = drizzle(adminPool);
    const targetUrl = new URL(databaseUrl!);
    targetUrl.pathname = `/${databaseName}`;
    let targetPool: Pool | undefined;
    let targetClient: PoolClient | undefined;
    let stagedMigrations: string | undefined;

    try {
      await adminDb.execute(sql.raw(`CREATE DATABASE "${databaseName}"`));
      targetPool = new Pool({ connectionString: targetUrl.toString(), max: 1 });
      targetPool.on("error", () => {});
      // Match production's request-scoped Client: hooks and nested adapter
      // transactions must use the same connection, not wait for another slot.
      targetClient = await targetPool.connect();
      const db = drizzle(targetClient, { schema });

      const preservedTables = [
        "users", "videos", "video_courses", "video_course_members",
        "chat_logs", "chat_log_evaluations", "scene_embeddings", "videoq_scenes",
        "app_user", "app_video",
      ];
      const preservedRows: Record<string, unknown[]> = {};
      if (initialState === "populated") {
        const removal = journal.entries.find((entry) => entry.tag === "0023_remove_study_mode")!;
        // Use the real pre-removal migrations, including all FK constraints.
        stagedMigrations = mkdtempSync(join(tmpdir(), "videoq-pre-removal-"));
        cpSync(migrationDirectory, stagedMigrations, { recursive: true });
        writeFileSync(join(stagedMigrations, "meta/_journal.json"), JSON.stringify({
          ...journal, entries: journal.entries.filter((entry) => entry.idx < removal.idx),
        }));
        await migrate(db, { migrationsFolder: stagedMigrations });
        await targetClient.query(readFileSync(new URL("./fixtures/study-removal.sql", import.meta.url), "utf8"));
        await expect(purgeRetiredStudyData(targetClient)).rejects.toThrow("Apply 0023");
        for (const table of legacyStudyTables) {
          expect((await targetClient.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n).toBeGreaterThan(0);
          await targetClient.query(`CREATE TABLE legacy_${table} AS TABLE ${table}`);
        }
        for (const table of preservedTables) {
          preservedRows[table] = (await targetClient.query(`SELECT to_jsonb(t) AS row FROM ${table} t`)).rows;
          expect(preservedRows[table]).toHaveLength(1);
          if (table === "users") {
            // Only obsolete role columns are removed; native roles and all other data survive.
            for (const { row } of preservedRows[table] as { row: Record<string, unknown> }[]) {
              delete row.is_staff;
              delete row.is_superuser;
              row.max_video_upload_size_mb = 5237760;
              row.monthly_upload_limit_gb = row.quota_source === 'admin' ? null : 2;
              row.used_upload_bytes = 0;
              row.upload_usage_period_start = null;
              if (row.quota_source === 'plan' && row.plan_code === 'free') {
                row.processing_limit_minutes = 45;
                row.updated_at = expect.any(String);
              }
            }
          }
          if (table === "videos") {
            // Existing videos gain nullable upload and language fields without changing media or state.
            for (const { row } of preservedRows[table] as { row: Record<string, unknown> }[]) {
              row.transcription_language = null;
              row.multipart_upload = null;
              row.upload_heartbeat_at = null;
              row.upload_usage_period_start = null;
            }
          }
        }
        preservedRows.external_tasks = (await targetClient.query("SELECT to_jsonb(t) AS row FROM external_tasks t WHERE dedupe_key LIKE 'keep-%' ORDER BY dedupe_key")).rows;
        preservedRows.job_executions = (await targetClient.query("SELECT to_jsonb(t) AS row FROM job_executions t WHERE job_id LIKE 'keep-%' ORDER BY job_id")).rows;

        // Conversion must fail before the old columns are dropped and remain retryable.
        const oldChat = (preservedRows.chat_logs[0] as { row: Record<string, unknown> }).row;
        await expect(migrateDatabase(targetClient)).rejects.toThrow("STRUCTURED_ANSWER_WRITERS_STOPPED=1");
        await targetClient.query("UPDATE chat_logs SET citations = '{}'::jsonb");
        await expect(migrateDatabase(targetClient, { writersStopped: true })).rejects.toThrow("Unable to migrate historical chat log");
        expect((await targetClient.query("SELECT response FROM chat_logs")).rows[0].response).toBeNull();
        await targetClient.query("UPDATE chat_logs SET citations = $1::jsonb", [JSON.stringify(oldChat.citations)]);
        const { answer, citations, ...unchanged } = oldChat;
        preservedRows.chat_logs = [{ row: { ...unchanged, response: convertHistoricalAnswer(answer as string, citations) } }];
        await expect(migrateDatabase(targetClient, { writersStopped: true, phase: "before-deploy" }))
          .rejects.toThrow("Complete the previous release's post-deploy role cleanup");
        // Reproduce the previous release's pre-deploy boundary before testing
        // its cleanup. The current release correctly refuses to skip 0028.
        writeFileSync(join(stagedMigrations, "meta/_journal.json"), JSON.stringify({
          ...journal, entries: journal.entries.filter((entry) => entry.idx <= 27),
        }));
        await migrate(db, { migrationsFolder: stagedMigrations });
        // A failure after DROP and outbox deletion must restore both. It can be
        // retried after the fault is resolved, even with 0023 already applied.
        await targetClient.query(`
          CREATE FUNCTION reject_test_job_delete() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'simulated cleanup failure'; END $$;
          CREATE TRIGGER reject_test_job_delete BEFORE DELETE ON job_executions
            FOR EACH ROW EXECUTE FUNCTION reject_test_job_delete();
        `);
        await expect(purgeRetiredStudyData(targetClient)).rejects.toThrow("simulated cleanup failure");
        for (const table of legacyStudyTables.flatMap((name) => [name, `legacy_${name}`])) {
          expect((await targetClient.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n).toBeGreaterThan(0);
        }
        expect((await targetClient.query("SELECT count(*)::integer AS n FROM external_tasks WHERE dedupe_key LIKE 'retired-%'")).rows[0].n).toBe(3);
        expect((await targetClient.query("SELECT count(*)::integer AS n FROM job_executions WHERE job_type = 'build_plog'")).rows[0].n).toBe(3);
        await targetClient.query("DROP TRIGGER reject_test_job_delete ON job_executions; DROP FUNCTION reject_test_job_delete()");
      }
      // Exercise the real production entrypoint, including legacy cleanup, for
      // both fresh installs and already populated databases, then retry it.
      const runMigration = (phase = "all") => spawnSync("sh", [
        fileURLToPath(new URL("../scripts/db-migrate.sh", import.meta.url)),
      ], {
        encoding: "utf8",
        // Fresh installs and already converted databases need no acknowledgement.
        env: { ...process.env, DATABASE_URL: targetUrl.toString(), STRUCTURED_ANSWER_WRITERS_STOPPED: "", MIGRATION_PHASE: phase },
        timeout: 20_000,
      });
      const blocked = runMigration("before-deploy");
      expect(blocked.status).not.toBe(0);
      expect(blocked.stdout + blocked.stderr).toContain("Complete the previous release's post-deploy role cleanup");
      await targetClient.query("SELECT is_staff, is_superuser FROM users");
      // Finish the previous release first, then verify that the current
      // pre-deploy phase applies 0029 instead of remaining capped at 0027.
      if (!stagedMigrations) {
        stagedMigrations = mkdtempSync(join(tmpdir(), "videoq-previous-release-"));
        cpSync(migrationDirectory, stagedMigrations, { recursive: true });
      }
      writeFileSync(join(stagedMigrations, "meta/_journal.json"), JSON.stringify({
        ...journal, entries: journal.entries.filter((entry) => entry.idx <= 28),
      }));
      await migrate(db, { migrationsFolder: stagedMigrations });
      for (let attempt = 0; attempt < 2; attempt++) {
        const prepared = runMigration("before-deploy");
        expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
        await targetClient.query("SELECT alg, crv FROM jwks");
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const migrated = runMigration();
        expect(migrated.error).toBeUndefined();
        expect(migrated.status, migrated.stdout + migrated.stderr).toBe(0);
      }
      const afterCleanup = runMigration("before-deploy");
      expect(afterCleanup.status, afterCleanup.stdout + afterCleanup.stderr).toBe(0);
      if (initialState === "populated") {
        for (const table of preservedTables) {
          expect((await targetClient.query(`SELECT to_jsonb(t) AS row FROM ${table} t`)).rows)
            .toEqual(preservedRows[table]);
        }
        expect((await targetClient.query("SELECT job_id FROM job_executions ORDER BY job_id")).rows)
          .toEqual([{ job_id: "keep-indexing" }, { job_id: "keep-transcription" }]);
        expect((await targetClient.query("SELECT dedupe_key FROM external_tasks ORDER BY dedupe_key")).rows)
          .toEqual([{ dedupe_key: "keep-indexing" }, { dedupe_key: "keep-storage-cleanup" }]);
        expect((await targetClient.query("SELECT to_jsonb(t) AS row FROM external_tasks t ORDER BY dedupe_key")).rows)
          .toEqual(preservedRows.external_tasks);
        expect((await targetClient.query("SELECT to_jsonb(t) AS row FROM job_executions t ORDER BY job_id")).rows)
          .toEqual(preservedRows.job_executions);
      }

      const result = await db.execute(sql.raw(`
        SELECT
          (SELECT count(*)::integer FROM drizzle.__drizzle_migrations) AS migration_count,
          to_regclass('public.users')::text AS users_table,
          to_regclass('public.mcp_idempotency_records')::text AS mcp_table,
          to_regclass('public.oauth_resource')::text AS oauth_resource_table
      `));
      expect(result.rows[0]).toEqual({
        migration_count: journal.entries.length,
        users_table: "users",
        mcp_table: "mcp_idempotency_records",
        oauth_resource_table: "oauth_resource",
      });

      expect((await targetClient.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users'
          AND column_name IN ('is_staff', 'is_superuser')`)).rows).toEqual([]);

      const retiredTables = await db.execute(sql.raw(`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND (tablename LIKE '%plog%' OR tablename LIKE '%learner%')
      `));
      expect(retiredTables.rows).toEqual([]);
      const retainedTables = await db.execute(sql.raw(`
        SELECT to_regclass('public.videos')::text AS videos,
               to_regclass('public.chat_logs')::text AS chat_logs,
               to_regclass('public.scene_embeddings')::text AS scene_embeddings
      `));
      expect(retainedTables.rows[0]).toEqual({
        videos: "videos", chat_logs: "chat_logs", scene_embeddings: "scene_embeddings",
      });

      // A successful migration can still disagree with the runtime schema.
      // In particular, deletion code must not assume cascades absent from SQL.
      const foreignKeys = Object.values(schema).flatMap((table) => {
        const config = getTableConfig(table);
        return config.foreignKeys.map((key) => {
          const reference = key.reference();
          return {
            table_name: config.name, name: key.getName(),
            columns: reference.columns.map((column) => column.name),
            foreign_table: getTableConfig(reference.foreignTable).name,
            foreign_columns: reference.foreignColumns.map((column) => column.name),
            on_delete: key.onDelete ?? "no action", on_update: key.onUpdate ?? "no action",
          };
        });
      }).sort((a, b) => `${a.table_name}.${a.name}`.localeCompare(`${b.table_name}.${b.name}`));
      const actualForeignKeys = await targetClient.query(`
        SELECT source.relname AS table_name, fk.conname AS name,
          ARRAY(SELECT attribute.attname::text FROM unnest(fk.conkey) WITH ORDINALITY AS key(num, ord)
            JOIN pg_attribute attribute ON attribute.attrelid = fk.conrelid AND attribute.attnum = key.num
            ORDER BY key.ord) AS columns,
          target.relname AS foreign_table,
          ARRAY(SELECT attribute.attname::text FROM unnest(fk.confkey) WITH ORDINALITY AS key(num, ord)
            JOIN pg_attribute attribute ON attribute.attrelid = fk.confrelid AND attribute.attnum = key.num
            ORDER BY key.ord) AS foreign_columns,
          CASE fk.confdeltype WHEN 'a' THEN 'no action' WHEN 'r' THEN 'restrict'
            WHEN 'c' THEN 'cascade' WHEN 'n' THEN 'set null' WHEN 'd' THEN 'set default' END AS on_delete,
          CASE fk.confupdtype WHEN 'a' THEN 'no action' WHEN 'r' THEN 'restrict'
            WHEN 'c' THEN 'cascade' WHEN 'n' THEN 'set null' WHEN 'd' THEN 'set default' END AS on_update
        FROM pg_constraint fk
        JOIN pg_class source ON source.oid = fk.conrelid
        JOIN pg_namespace namespace ON namespace.oid = source.relnamespace
        JOIN pg_class target ON target.oid = fk.confrelid
        WHERE fk.contype = 'f' AND namespace.nspname = 'public'
          AND source.relname = ANY($1::text[])
      `, [Object.values(schema).map((table) => getTableConfig(table).name)]);
      expect(actualForeignKeys.rows.sort((a, b) => `${a.table_name}.${a.name}`.localeCompare(`${b.table_name}.${b.name}`)))
        .toEqual(foreignKeys);

      // Verify the migrated schema with the real Admin API and transaction
      // adapter used by the existing settings/admin UI.
      const adminId = crypto.randomUUID();
      const targetId = crypto.randomUUID();
      const base = "https://native-auth.example.test";
      const env = {
        ENVIRONMENT: "test", BETTER_AUTH_URL: base, FRONTEND_URL: base, CORS_ALLOW_ORIGIN: base,
        BETTER_AUTH_SECRET: "native-auth-test-secret-012345678901234567890123456789",
        HYPERDRIVE: { connectionString: targetUrl.toString() },
      } as Bindings;
      const password = "native-auth-test-password-123";
      const quota = { maxVideoUploadSizeMb: 500, isOverQuota: false, usedAiAnswers: 0, usedProcessingSeconds: 0, usedStorageBytes: 0 };
      await db.insert(users).values([
        { ...quota, id: adminId, username: "admin", email: "admin@example.test", emailVerified: true, role: "admin" },
        // Stale legacy values must have no effect after the migration.
        { ...quota, id: targetId, username: "target", email: "target@example.test", emailVerified: true, role: "user", isActive: false },
      ]);
      await db.insert(account).values({
        id: crypto.randomUUID(), accountId: adminId, userId: adminId,
        issuer: "local:credential", providerId: "credential", password: await hashPassword(password),
      });
      const auth = createAuth(env, db);
      const createdAdmin = await auth.api.createUser({ body: {
        name: "Native Admin", email: "created-admin@example.test", role: "admin",
      } });
      expect(createdAdmin.user.role).toBe("admin");
      const signedIn = await auth.api.signInEmail({ body: { email: "admin@example.test", password }, asResponse: true });
      expect(signedIn.status).toBe(200);
      const headers = new Headers({ cookie: signedIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ") });
      expect(await isAdmin(env, targetId)).toBe(false);
      expect(await getCurrentUser(env, targetId)).toMatchObject({ is_admin: false });
      expect(await getAdminUser(env, targetId)).toMatchObject({ is_active: true, is_admin: false });

      expect(await patchFlags(env, adminId, targetId, { is_active: false, is_admin: true }, headers))
        .toMatchObject({ user: { is_active: false, is_admin: true } });
      expect(await patchFlags(env, adminId, targetId, { is_active: true, is_admin: false }, headers))
        .toMatchObject({ user: { is_active: true, is_admin: false } });
      expect(await isAdmin(env, targetId)).toBe(false);
      expect(await getCurrentUser(env, targetId)).toMatchObject({ is_admin: false });

      await expect(patchFlags(env, adminId, targetId, { is_active: false }, new Headers()))
        .rejects.toMatchObject({ statusCode: 401 });
      expect(await getAdminUser(env, targetId)).toMatchObject({ is_active: true });

      // The bootstrap command must also work after the obsolete columns are gone.
      await targetClient.query("UPDATE users SET email_verified = false, banned = true WHERE id = $1", [targetId]);
      const promoted = spawnSync(process.execPath, [
        fileURLToPath(new URL("../scripts/create-admin.mjs", import.meta.url)), "target@example.test",
      ], {
        encoding: "utf8", env: { ...process.env, DATABASE_URL: targetUrl.toString() }, timeout: 10_000,
      });
      expect(promoted.status, promoted.stdout + promoted.stderr).toBe(0);
      expect((await targetClient.query("SELECT role, banned, email_verified FROM users WHERE id = $1", [targetId])).rows[0])
        .toEqual({ role: "admin", banned: false, email_verified: true });
      expect(await isAdmin(env, targetId)).toBe(true);
    } finally {
      targetClient?.release();
      await targetPool?.end();
      await adminDb.execute(
        sql.raw(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`),
      );
      await adminPool.end();
      if (stagedMigrations) rmSync(stagedMigrations, { recursive: true, force: true });
    }
  }, 60_000);
});
