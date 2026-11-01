import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  reserveStorageInTransaction,
  releaseAiAnswerReservation,
  reserveAiAnswerUsage,
} from "../src/repositories/quota-repository";
import { reserveAndCreatePendingVideo } from "../src/repositories/video-repository";
import { withDb } from "../src/db/pool";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const userId = "quota-concurrency-user";
type QuotaEnv = Parameters<typeof reserveAiAnswerUsage>[0];

const checkAndReserveStorage = (env: QuotaEnv, userId: string, bytes: number) =>
  withDb(env, (db) => db.transaction((tx) => reserveStorageInTransaction(tx, userId, bytes)));

describeWithPostgres("AI回答枠の実PostgreSQL並列制御", () => {
  const schemaName = `quota_concurrency_${crypto.randomUUID().replaceAll("-", "")}`;
  const quotedSchema = `"${schemaName}"`;
  let admin: pg.Client;
  let adminConnected = false;
  let env: QuotaEnv;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    adminConnected = true;
    await admin.query(`CREATE SCHEMA ${quotedSchema}`);
    await admin.query(`
      CREATE TABLE ${quotedSchema}.users (
        id text PRIMARY KEY,
        is_over_quota boolean NOT NULL DEFAULT false,
        max_video_upload_size_mb integer NOT NULL DEFAULT 500,
        ai_answers_limit integer,
        used_ai_answers integer NOT NULL DEFAULT 0,
        plan_code text NOT NULL DEFAULT 'free',
        quota_source text NOT NULL DEFAULT 'plan',
        used_processing_seconds integer NOT NULL DEFAULT 0,
        usage_period_start timestamptz,
        storage_limit_gb double precision,
        used_storage_bytes bigint NOT NULL DEFAULT 0,
        monthly_upload_limit_gb double precision, used_upload_bytes bigint NOT NULL DEFAULT 0, upload_usage_period_start timestamptz
      )
    `);
    await admin.query(`
      CREATE TABLE ${quotedSchema}.videos (
        transcription_language varchar(3), multipart_upload jsonb, upload_heartbeat_at timestamptz, upload_usage_period_start timestamptz,
        id bigserial PRIMARY KEY,
        user_id text NOT NULL,
        file varchar(255) NOT NULL UNIQUE,
        title varchar(255) NOT NULL,
        description text NOT NULL,
        status varchar(20) NOT NULL,
        source_type varchar(20) NOT NULL,
        source_url text NOT NULL,
        youtube_video_id varchar(20) NOT NULL,
        transcript text NOT NULL,
        error_message text NOT NULL,
        processing_seconds integer NOT NULL DEFAULT 0,
        uploaded_at timestamptz NOT NULL
      )
    `);
    await admin.query(
      `INSERT INTO ${quotedSchema}.users
         (id, ai_answers_limit, usage_period_start)
       VALUES ($1, 3, now())`,
      [userId],
    );

    const scopedUrl = new URL(databaseUrl!);
    scopedUrl.searchParams.set("options", `-c search_path=${schemaName}`);
    env = {
      HYPERDRIVE: { connectionString: scopedUrl.toString() },
    } as QuotaEnv;
  });

  afterAll(async () => {
    if (!adminConnected) return;
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    } finally {
      await admin.end();
    }
  });

  it("20件を同時実行しても上限3件だけを予約する", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => reserveAiAnswerUsage(env, userId)),
    );
    const reservations = results.flatMap((result) =>
      "reservation" in result ? [result.reservation] : [],
    );

    expect(reservations).toHaveLength(3);
    expect(reservations.every((reservation) => reservation.planCode === "free" && reservation.quotaSource === "plan")).toBe(true);
    expect(results.filter((result) => "exceeded" in result)).toHaveLength(17);

    const state = await admin.query<{ used_ai_answers: number }>(
      `SELECT used_ai_answers FROM ${quotedSchema}.users WHERE id = $1`,
      [userId],
    );
    expect(state.rows[0].used_ai_answers).toBe(3);

    await Promise.all(
      reservations.map((reservation) =>
        releaseAiAnswerReservation(env, reservation),
      ),
    );
    const released = await admin.query<{ used_ai_answers: number }>(
      `SELECT used_ai_answers FROM ${quotedSchema}.users WHERE id = $1`,
      [userId],
    );
    expect(released.rows[0].used_ai_answers).toBe(0);
  });

  it("ストレージ残り3 bytesへ20件を同時予約しても3件だけ成功する", async () => {
    await admin.query(
      `UPDATE ${quotedSchema}.users
          SET used_storage_bytes = 0,
              storage_limit_gb = 3.0 / 1073741824.0,
              is_over_quota = false
        WHERE id = $1`,
      [userId],
    );

    const results = await Promise.all(
      Array.from({ length: 20 }, () => checkAndReserveStorage(env, userId, 1)),
    );

    expect(results.filter((result) => "ok" in result)).toHaveLength(3);
    expect(results.filter((result) => "exceeded" in result)).toHaveLength(17);
    const state = await admin.query<{ used_storage_bytes: string }>(
      `SELECT used_storage_bytes FROM ${quotedSchema}.users WHERE id = $1`,
      [userId],
    );
    expect(Number(state.rows[0].used_storage_bytes)).toBe(3);
  });

  it("容量予約とuploading動画作成を並列でも同じtransactionに保つ", async () => {
    await admin.query(`DELETE FROM ${quotedSchema}.videos`);
    await admin.query(
      `UPDATE ${quotedSchema}.users
          SET used_storage_bytes = 0,
              storage_limit_gb = 3.0 / 1073741824.0,
              is_over_quota = false
        WHERE id = $1`,
      [userId],
    );

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        reserveAndCreatePendingVideo(
          env,
          userId,
          1,
          `videos/${userId}/concurrent-${index}.mp4`,
          `video-${index}`,
          "",
        ),
      ),
    );

    expect(results.filter((result) => "ok" in result)).toHaveLength(3);
    expect(results.filter((result) => "exceeded" in result)).toHaveLength(17);
    const state = await admin.query<{ used_storage_bytes: string; videos: string }>(
      `SELECT u.used_storage_bytes,
              (SELECT count(*) FROM ${quotedSchema}.videos)::text AS videos
         FROM ${quotedSchema}.users u
        WHERE u.id = $1`,
      [userId],
    );
    expect(Number(state.rows[0].used_storage_bytes)).toBe(3);
    expect(Number(state.rows[0].videos)).toBe(3);
  });

  it("動画INSERT失敗時は同じtransactionの容量予約もrollbackする", async () => {
    await admin.query(`DELETE FROM ${quotedSchema}.videos`);
    await admin.query(
      `UPDATE ${quotedSchema}.users
          SET used_storage_bytes = 0,
              storage_limit_gb = NULL,
              is_over_quota = false
        WHERE id = $1`,
      [userId],
    );
    const fileKey = `videos/${userId}/duplicate.mp4`;
    await reserveAndCreatePendingVideo(env, userId, 1, fileKey, "first", "");

    await expect(
      reserveAndCreatePendingVideo(env, userId, 1, fileKey, "second", ""),
    ).rejects.toThrow();

    const state = await admin.query<{ used_storage_bytes: string; videos: string }>(
      `SELECT u.used_storage_bytes,
              (SELECT count(*) FROM ${quotedSchema}.videos)::text AS videos
         FROM ${quotedSchema}.users u
        WHERE u.id = $1`,
      [userId],
    );
    expect(Number(state.rows[0].used_storage_bytes)).toBe(1);
    expect(Number(state.rows[0].videos)).toBe(1);
  });
});
