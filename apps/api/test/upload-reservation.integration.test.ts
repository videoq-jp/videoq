import { visualSchema } from "./helpers/visual-schema";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createVideoFromMultipart, requestPresignedUpload } from "../src/features/videos/service";
import * as media from "../src/integrations/media";
import * as externalTasks from "../src/lib/external-tasks";
import { reserveAndCreatePendingVideo, deleteVideoCascade, listStaleUploadingVideos } from "../src/repositories/video-repository";
import { completeMultipartVideoUpload, getMultipartUploadPartUrl } from "../src/repositories/multipart-upload-repository";
import { multipartPartSize } from "@videoq/trpc/video-upload";
import type { CreationIdempotency } from "../src/repositories/mcp-idempotency-repository";
import type { Bindings } from "../src/types/bindings";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
const MIB = 1024 * 1024;
type UploadMode = "presigned" | "multipart";
const modes: UploadMode[] = ["presigned", "multipart"];

(databaseUrl ? describe : describe.skip)("upload reservation limits on PostgreSQL", () => {
  const schema = `upload_reservation_${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let env: Bindings;
  const armAt = vi.fn(async () => {});

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`
      CREATE SCHEMA "${schema}";
      SET search_path TO "${schema}";
      CREATE TABLE users (
        id text PRIMARY KEY, max_video_upload_size_mb integer NOT NULL DEFAULT 1,
        is_over_quota boolean NOT NULL DEFAULT false, storage_limit_gb numeric DEFAULT 10,
        used_storage_bytes bigint NOT NULL DEFAULT 0, monthly_upload_limit_gb numeric DEFAULT (1.0 / 1024),
        used_upload_bytes bigint NOT NULL DEFAULT 0, upload_usage_period_start timestamptz
      );
      CREATE TABLE videos (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id text REFERENCES users,
        file text NOT NULL UNIQUE, title text NOT NULL, description text NOT NULL,
        status text NOT NULL, source_type text NOT NULL, source_url text NOT NULL,
        youtube_video_id text NOT NULL, transcript text NOT NULL, error_message text NOT NULL,
        processing_seconds integer NOT NULL DEFAULT 0, uploaded_at timestamptz NOT NULL,
        transcription_language varchar(3), multipart_upload jsonb, upload_heartbeat_at timestamptz, upload_usage_period_start timestamptz
      );
      CREATE TABLE scene_embeddings (video_id integer);
      CREATE TABLE tags (id integer PRIMARY KEY, name text, color text);
      CREATE TABLE video_tags (id integer PRIMARY KEY, video_id integer REFERENCES videos, tag_id integer REFERENCES tags);
      CREATE TABLE mcp_idempotency_records (
        user_id text NOT NULL, action text NOT NULL, key text NOT NULL,
        request_hash text NOT NULL, resource_id bigint NOT NULL, created_at timestamptz NOT NULL,
        PRIMARY KEY (user_id, action, key)
      );
      CREATE TABLE external_tasks (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        kind text NOT NULL, payload jsonb NOT NULL, dedupe_key text NOT NULL UNIQUE,
        attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
        locked_at timestamptz, completed_at timestamptz, dead_at timestamptz,
        effect_applied_at timestamptz, last_error text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await admin.query(visualSchema);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    url.searchParams.set("application_name", schema);
    env = {
      HYPERDRIVE: { connectionString: url.toString() }, USE_S3_STORAGE: "true",
      TASK_SCHEDULER: { getByName: () => ({ armAt }) },
    } as unknown as Bindings;
  });
  beforeEach(async () => {
    await admin.query("TRUNCATE users, videos, video_tags, mcp_idempotency_records, external_tasks, video_visual_chunks, video_visual_runs RESTART IDENTITY");
    await admin.query("INSERT INTO users (id) VALUES ('owner')");
    armAt.mockClear();
    vi.spyOn(media, "presignR2Put").mockResolvedValue("https://uploads.example.test/video");
    vi.spyOn(media, "putMediaObject").mockResolvedValue(undefined);
    vi.spyOn(media, "resolveFileUrl").mockImplementation(async (_env, key) => key ? `/api/media/${key}` : null);
    vi.spyOn(externalTasks, "processExternalTaskById").mockResolvedValue(true);
    vi.spyOn(media, "createR2MultipartUpload").mockResolvedValue("upload-session");
    vi.spyOn(media, "abortR2MultipartUpload").mockResolvedValue();
    vi.spyOn(media, "completeR2MultipartUpload").mockResolvedValue();
    vi.spyOn(media, "presignR2UploadPart").mockResolvedValue("https://uploads.example.test/part");
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); }
  });

  function upload(mode: UploadMode, bytes = MIB, idempotency?: CreationIdempotency) {
    return mode === "presigned"
      ? requestPresignedUpload(env, "owner", {
        filename: "clip.mp4", content_type: "video/mp4", file_size: bytes, title: "Clip", description: "",
      }, idempotency)
      : createVideoFromMultipart({ ...env, USE_S3_STORAGE: "false" }, "owner", {
        file: new File([new Uint8Array(bytes)], "clip.mp4", { type: "video/mp4" }), title: "Clip", description: "",
      });
  }

  it.each(modes)('persists the selected audio language (%s)', async mode => {
    if (mode === 'presigned') {
      await requestPresignedUpload(env, 'owner', {
        filename: 'clip.mp4', content_type: 'video/mp4', file_size: 1,
        title: 'Clip', description: '', transcriptionLanguage: 'ja',
      });
    } else {
      await createVideoFromMultipart({ ...env, USE_S3_STORAGE: 'false' }, 'owner', {
        file: new File(['x'], 'clip.mp4', { type: 'video/mp4' }),
        title: 'Clip', description: '', transcriptionLanguage: 'en',
      });
    }
    expect((await admin.query('SELECT transcription_language FROM videos')).rows)
      .toEqual([{ transcription_language: mode === 'presigned' ? 'ja' : 'en' }]);
  });

  function expectMonthlyLimit(result: unknown, mode: UploadMode) {
    expect(result).toEqual(mode === "presigned"
      ? { badRequest: "Monthly upload allowance exceeded.", code: "MONTHLY_UPLOAD_LIMIT_EXCEEDED" }
      : { ok: false, status: 400, body: { error: {
        code: "MONTHLY_UPLOAD_LIMIT_EXCEEDED", message: "Monthly upload allowance exceeded.",
      } } });
  }

  async function expectNoReservation() {
    expect((await admin.query("SELECT used_storage_bytes FROM users WHERE id = 'owner'")).rows)
      .toEqual([{ used_storage_bytes: "0" }]);
    for (const table of ["videos", "mcp_idempotency_records", "external_tasks"]) {
      expect((await admin.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
    }
    expect(media.presignR2Put).not.toHaveBeenCalled();
    expect(media.putMediaObject).not.toHaveBeenCalled();
    expect(externalTasks.processExternalTaskById).not.toHaveBeenCalled();
    expect(armAt).not.toHaveBeenCalled();
  }

  it.each(modes)("accepts the exact monthly upload limit without a separate limit connection (%s)", async mode => {
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    const result = await upload(mode);
    expect(result).toMatchObject({ video: { id: 1, status: mode === "presigned" ? "uploading" : "pending" } });
    expect(connect).toHaveBeenCalledTimes(mode === "presigned" ? 2 : 3);
    expect((await admin.query("SELECT used_storage_bytes FROM users")).rows).toEqual([{ used_storage_bytes: String(MIB) }]);
  });

  it.each(modes)("rejects one byte over the monthly limit before any reservation or media write (%s)", async mode => {
    expectMonthlyLimit(await upload(mode, MIB + 1), mode);
    await expectNoReservation();
  });

  it.each(modes)("honors a zero-byte upload allowance (%s)", async mode => {
    await admin.query("UPDATE users SET monthly_upload_limit_gb = 0");
    expectMonthlyLimit(await upload(mode, 1), mode);
    await expectNoReservation();
  });

  it.each(modes)("does not enforce the retired account per-file limit (%s)", async mode => {
    await admin.query("UPDATE users SET max_video_upload_size_mb = 0, monthly_upload_limit_gb = 1");
    expect(await upload(mode, 2 * MIB)).toMatchObject({ video: { id: 1 } });
  });

  it.each(modes.flatMap(mode => ["decrease", "increase"].map(change => ({ mode, change }))))(
    "observes a concurrent limit $change after the owner lock is released ($mode)",
    async ({ mode, change }) => {
      const writer = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString });
      await writer.connect();
      let pending: Promise<unknown> | undefined;
      try {
        if (change === "decrease") await admin.query("UPDATE users SET monthly_upload_limit_gb = 2.0 / 1024");
        await writer.query("BEGIN");
        await writer.query("SELECT id FROM users WHERE id = 'owner' FOR UPDATE");
        pending = upload(mode, 2 * MIB).catch(error => error);
        await vi.waitFor(async () => {
          const blocked = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND cardinality(pg_blocking_pids(pid)) > 0", [schema]);
          expect(blocked.rowCount).toBe(1);
        }, { timeout: 5_000 });
        await writer.query("UPDATE users SET monthly_upload_limit_gb = $1 / 1024.0 WHERE id = 'owner'", [change === "decrease" ? 1 : 2]);
        await writer.query("COMMIT");
        const result = await pending;
        if (change === "decrease") {
          expectMonthlyLimit(result, mode);
          await expectNoReservation();
        } else {
          expect(result).toMatchObject({ video: { id: 1 } });
          expect((await admin.query("SELECT used_storage_bytes FROM users")).rows).toEqual([{ used_storage_bytes: String(2 * MIB) }]);
        }
      } finally {
        await writer.query("ROLLBACK");
        await pending;
        await writer.end();
      }
    },
    15_000,
  );

  it("keeps concurrent idempotent retries to one reservation and video", async () => {
    const idempotency: CreationIdempotency = { action: "request_video_upload", key: "same-upload", requestHash: "a".repeat(64) };
    const results = await Promise.all(Array.from({ length: 6 }, () => upload("presigned", MIB, idempotency)));
    expect(results.every(result => "video" in result && result.video?.id === 1)).toBe(true);
    expect(results.filter(result => "reused" in result && result.reused)).toHaveLength(5);
    expect((await admin.query("SELECT used_storage_bytes FROM users")).rows).toEqual([{ used_storage_bytes: String(MIB) }]);
    expect((await admin.query("SELECT * FROM videos")).rows).toHaveLength(1);
    expect((await admin.query("SELECT * FROM mcp_idempotency_records")).rows).toHaveLength(1);

    vi.mocked(media.presignR2Put).mockClear();
    expect(await upload("presigned", MIB, { ...idempotency, requestHash: "b".repeat(64) }))
      .toEqual({ idempotencyConflict: true });
    await admin.query("UPDATE users SET monthly_upload_limit_gb = 0");
    expect(await upload("presigned", MIB, idempotency)).toMatchObject({ reused: true });
    expect(media.presignR2Put).toHaveBeenCalledTimes(1);
    expect((await admin.query("SELECT used_storage_bytes FROM users")).rows).toEqual([{ used_storage_bytes: String(MIB) }]);
  });

  it("enforces the limit for direct repository callers", async () => {
    expect(await reserveAndCreatePendingVideo(env, "owner", MIB + 1, "videos/owner/clip.mp4", "Clip", ""))
      .toEqual({ monthlyUploadExceeded: true, limit: MIB });
    await expectNoReservation();
  });

  it("reports a missing owner without creating orphan reservations", async () => {
    await admin.query("DELETE FROM users");
    await expect(reserveAndCreatePendingVideo(env, "owner", 1, "videos/owner/clip.mp4", "Clip", ""))
      .rejects.toThrow("Quota owner not found");
    expect((await admin.query("SELECT * FROM videos")).rows).toEqual([]);
  });

  it("reserves both limits atomically under twenty concurrent uploads", async () => {
    await admin.query("UPDATE users SET monthly_upload_limit_gb = 3.0 / 1024");
    const results = await Promise.all(Array.from({ length: 20 }, () => upload("presigned")));
    expect(results.filter(r => "video" in r)).toHaveLength(3);
    expect(results.filter(r => "code" in r && r.code === "MONTHLY_UPLOAD_LIMIT_EXCEEDED")).toHaveLength(17);
    expect((await admin.query("SELECT used_storage_bytes, used_upload_bytes FROM users")).rows)
      .toEqual([{ used_storage_bytes: String(3 * MIB), used_upload_bytes: String(3 * MIB) }]);
  });

  it("does not consume the monthly allowance when storage admission fails", async () => {
    await admin.query("UPDATE users SET storage_limit_gb = 0");
    expect(await upload("presigned")).toMatchObject({ code: "STORAGE_LIMIT_EXCEEDED" });
    expect((await admin.query("SELECT used_upload_bytes FROM users")).rows).toEqual([{ used_upload_bytes: "0" }]);
    await expectNoReservation();
  });

  it("refunds an aborted reservation only once", async () => {
    await upload("presigned");
    const results = await Promise.all(Array.from({ length: 4 }, () => deleteVideoCascade(env, 1, "owner", { expectedStatus: "uploading" })));
    expect(results.filter(r => r.deleted)).toHaveLength(1);
    expect((await admin.query("SELECT used_upload_bytes FROM users")).rows).toEqual([{ used_upload_bytes: "0" }]);
    // Physical storage is held until the durable R2 cleanup actually succeeds.
    expect((await admin.query("SELECT used_storage_bytes FROM users")).rows).toEqual([{ used_storage_bytes: String(MIB) }]);
  });

  it("does not refund a confirmed upload when the video is deleted", async () => {
    await upload("multipart");
    await deleteVideoCascade(env, 1, "owner");
    expect((await admin.query("SELECT used_upload_bytes FROM users")).rows).toEqual([{ used_upload_bytes: String(MIB) }]);
    expectMonthlyLimit(await upload("presigned", 1), "presigned");
  });

  it("starts a new UTC month without deleting videos or resetting retained storage", async () => {
    await upload("presigned");
    await admin.query("UPDATE users SET upload_usage_period_start = date_trunc('month', now(), 'UTC') - interval '1 month'");
    await admin.query("UPDATE videos SET upload_usage_period_start = date_trunc('month', now(), 'UTC') - interval '1 month'");
    expect(await upload("presigned")).toMatchObject({ video: { id: 2 } });
    expect((await admin.query("SELECT count(*) FROM videos")).rows).toEqual([{ count: "2" }]);
    expect((await admin.query("SELECT used_storage_bytes, used_upload_bytes FROM users")).rows)
      .toEqual([{ used_storage_bytes: String(2 * MIB), used_upload_bytes: String(MIB) }]);
    await deleteVideoCascade(env, 1, "owner", { expectedStatus: "uploading" });
    expect((await admin.query("SELECT used_upload_bytes FROM users")).rows).toEqual([{ used_upload_bytes: String(MIB) }]);
  });

  it("rolls back both reservations if video creation fails", async () => {
    await admin.query(`CREATE FUNCTION reject_upload() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'video insert failed'; END $$;
      CREATE TRIGGER reject_upload BEFORE INSERT ON videos FOR EACH ROW EXECUTE FUNCTION reject_upload();`);
    try {
      await expect(upload("presigned")).rejects.toThrow();
      await expectNoReservation();
      expect((await admin.query("SELECT used_upload_bytes FROM users")).rows).toEqual([{ used_upload_bytes: "0" }]);
    } finally { await admin.query("DROP TRIGGER reject_upload ON videos; DROP FUNCTION reject_upload()"); }
  });

  async function startMultipart(bytes = 130 * MIB) {
    await admin.query("UPDATE users SET max_video_upload_size_mb = 0, storage_limit_gb = 100, monthly_upload_limit_gb = 200");
    const result = await requestPresignedUpload(env, "owner", {
      filename: "clip.mkv", content_type: "video/matroska", file_size: bytes,
      title: "Large video", description: "", multipart: true,
    });
    expect(result).toMatchObject({ video: { id: 1, status: "uploading" }, upload_url: null });
    return result;
  }

  function parts(count = 3) {
    return Array.from({ length: count }, (_, index) => ({ partNumber: index + 1, etag: String(index + 1).repeat(32) }));
  }

  it("reserves 45.16 GB and signs only the exact bytes of each authorized part", async () => {
    const size = 45_160_000_000;
    const partSize = multipartPartSize(size);
    const count = Math.ceil(size / partSize);
    expect(await startMultipart(size)).toMatchObject({ multipart: { part_size: partSize, part_count: count } });
    expect(media.presignR2Put).not.toHaveBeenCalled();
    expect((await admin.query("SELECT used_storage_bytes FROM users")).rows[0].used_storage_bytes).toBe(String(size));
    await getMultipartUploadPartUrl(env, 1, "owner", 1);
    await getMultipartUploadPartUrl(env, 1, "owner", count);
    expect(media.presignR2UploadPart).toHaveBeenNthCalledWith(1, env, expect.any(String), "upload-session", 1, "video/matroska", partSize);
    expect(media.presignR2UploadPart).toHaveBeenNthCalledWith(2, env, expect.any(String), "upload-session", count, "video/matroska", size - (count - 1) * partSize);
    await expect(getMultipartUploadPartUrl(env, 1, "owner", count + 1)).rejects.toThrow("Invalid upload part");
    await expect(getMultipartUploadPartUrl(env, 1, "outsider", 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(completeMultipartVideoUpload(env, 1, "outsider", parts(count))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(media.presignR2UploadPart).toHaveBeenCalledTimes(2);
  });

  it("rejects oversized single PUTs and multipart quota violations before R2 creation", async () => {
    expect(await upload("presigned", 6 * 1024 ** 3)).toHaveProperty("fieldError.file_size");
    expect(await requestPresignedUpload(env, "owner", {
      filename: "clip.mkv", content_type: "video/matroska", file_size: 130 * MIB,
      title: "Video", description: "", multipart: true,
    })).toEqual({ badRequest: "Monthly upload allowance exceeded.", code: "MONTHLY_UPLOAD_LIMIT_EXCEEDED" });
    expect(media.createR2MultipartUpload).not.toHaveBeenCalled();
    await expectNoReservation();
  });

  it("keeps a long-running upload alive and rechecks a heartbeat before stale cleanup", async () => {
    await startMultipart();
    await admin.query("UPDATE videos SET uploaded_at = now() - interval '4 hours', upload_heartbeat_at = now() - interval '3 hours'");
    expect(await listStaleUploadingVideos(env, 2)).toHaveLength(1);
    await getMultipartUploadPartUrl(env, 1, "owner", 1);
    expect(await listStaleUploadingVideos(env, 2)).toEqual([]);
    expect(await deleteVideoCascade(env, 1, "owner", { expectedStatus: "uploading", inactiveBefore: new Date(Date.now() - 2 * 3600000) }))
      .toEqual({ deleted: false, cleanupTaskId: null });
  });

  it.each([[], parts(2), [parts()[0], parts()[0], parts()[2]], [...parts().slice(0, 2), { partNumber: 4, etag: "a".repeat(32) }]].map(manifest => [manifest]))(
    "rejects incomplete or duplicate manifests before storage completion (%j)", async manifest => {
      await startMultipart();
      await expect(completeMultipartVideoUpload(env, 1, "owner", manifest)).rejects.toThrow("missing or invalid");
      expect(media.completeR2MultipartUpload).not.toHaveBeenCalled();
    },
  );

  it("completes once under concurrent requests, validates size, and enqueues once", async () => {
    await startMultipart();
    vi.spyOn(media, "getR2ObjectSize").mockResolvedValueOnce(null).mockResolvedValue(130 * MIB);
    const results = await Promise.all(Array.from({ length: 5 }, () => completeMultipartVideoUpload(env, 1, "owner", parts().reverse())));
    expect(results.filter(value => value !== null)).toHaveLength(1);
    expect(media.completeR2MultipartUpload).toHaveBeenCalledExactlyOnceWith(env, expect.any(String), "upload-session", parts());
    expect((await admin.query("SELECT status, multipart_upload FROM videos")).rows).toEqual([{ status: "pending", multipart_upload: null }]);
    expect((await admin.query("SELECT kind FROM external_tasks")).rows).toEqual([{ kind: "sqs_job" }]);
    await expect(getMultipartUploadPartUrl(env, 1, "owner", 1)).rejects.toThrow("not active");
    expect(await deleteVideoCascade(env, 1, "owner", { expectedStatus: "uploading" })).toMatchObject({ deleted: false });
  });

  it("recovers when R2 completion succeeds but its response is lost", async () => {
    await startMultipart();
    vi.spyOn(media, "getR2ObjectSize").mockResolvedValueOnce(null).mockResolvedValue(130 * MIB);
    vi.mocked(media.completeR2MultipartUpload).mockRejectedValueOnce(new Error("Connection lost"));
    await expect(completeMultipartVideoUpload(env, 1, "owner", parts())).rejects.toThrow("Connection lost");
    await completeMultipartVideoUpload(env, 1, "owner", parts());
    expect(media.completeR2MultipartUpload).toHaveBeenCalledTimes(1);
    expect((await admin.query("SELECT kind FROM external_tasks")).rows).toEqual([{ kind: "sqs_job" }]);
  });

  it("does not queue a mismatched object and durably records abort plus capacity cleanup", async () => {
    await startMultipart();
    vi.spyOn(media, "getR2ObjectSize").mockResolvedValue(1);
    await expect(completeMultipartVideoUpload(env, 1, "owner", parts())).rejects.toThrow("size does not match");
    await deleteVideoCascade(env, 1, "owner", { expectedStatus: "uploading" });
    expect(await deleteVideoCascade(env, 1, "owner", { expectedStatus: "uploading" })).toMatchObject({ deleted: false });
    expect((await admin.query("SELECT kind, payload FROM external_tasks")).rows).toEqual([{
      kind: "storage_cleanup", payload: expect.objectContaining({ multipart_upload_id: "upload-session", bytes: 130 * MIB, user_id: "owner" }),
    }]);
  });

  it("recovers a completed R2 object after the queue transaction fails", async () => {
    await startMultipart();
    vi.spyOn(media, "getR2ObjectSize").mockResolvedValueOnce(null).mockResolvedValue(130 * MIB);
    await admin.query(`
      CREATE FUNCTION reject_multipart_job() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'job insert failed'; END $$;
      CREATE TRIGGER reject_multipart_job BEFORE INSERT ON external_tasks FOR EACH ROW EXECUTE FUNCTION reject_multipart_job();
    `);
    try {
      await expect(completeMultipartVideoUpload(env, 1, "owner", parts())).rejects.toThrow();
      expect((await admin.query("SELECT status, multipart_upload FROM videos")).rows).toEqual([{
        status: "uploading", multipart_upload: expect.objectContaining({ uploadId: "upload-session" }),
      }]);
    } finally {
      await admin.query("DROP TRIGGER reject_multipart_job ON external_tasks; DROP FUNCTION reject_multipart_job()");
    }
    await completeMultipartVideoUpload(env, 1, "owner", parts());
    expect(media.completeR2MultipartUpload).toHaveBeenCalledTimes(1);
    expect((await admin.query("SELECT kind FROM external_tasks")).rows).toEqual([{ kind: "sqs_job" }]);
  });

  it("serializes completion and abort so a completed upload cannot be cancelled", async () => {
    await startMultipart();
    let release!: () => void;
    const storage = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const completing = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(media, "getR2ObjectSize").mockResolvedValueOnce(null).mockResolvedValue(130 * MIB);
    vi.mocked(media.completeR2MultipartUpload).mockImplementationOnce(async () => { entered(); await storage; });
    const completion = completeMultipartVideoUpload(env, 1, "owner", parts());
    await completing;
    const abort = deleteVideoCascade(env, 1, "owner", { expectedStatus: "uploading" });
    release();
    await completion;
    expect(await abort).toMatchObject({ deleted: false });
    expect((await admin.query("SELECT kind FROM external_tasks")).rows).toEqual([{ kind: "sqs_job" }]);
  });
});
