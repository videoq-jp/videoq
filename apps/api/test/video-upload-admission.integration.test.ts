import { URL } from "node:url";
import { visualSchema } from "./helpers/visual-schema";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmVideoUpload, patchUserVideo } from "../src/features/videos/service";
import * as media from "../src/integrations/media";
import * as externalTasks from "../src/lib/external-tasks";
import { INVALID_SRT_MESSAGE } from "../src/lib/srt";
import type { Bindings } from "../src/types/bindings";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
const fixture = readFileSync(new URL("./fixtures/video-deletion.sql", import.meta.url), "utf8");
const fileKey = "videos/owner/video_1700000000000_4096.mp4";
const originalTranscript = "1\n00:00:00,000 --> 00:00:01,000\nOriginal";

(databaseUrl ? describe : describe.skip)("video upload admission on PostgreSQL", () => {
  const schema = `video_admission_${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let env: Bindings;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    url.searchParams.set("application_name", schema);
    env = { HYPERDRIVE: { connectionString: url.toString() }, USE_S3_STORAGE: "false" } as Bindings;
  });
  beforeEach(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(fixture);
    await admin.query(visualSchema);
    await admin.query(`
      ALTER TABLE videos
        ADD COLUMN title text NOT NULL DEFAULT 'Original',
        ADD COLUMN description text NOT NULL DEFAULT '',
        ADD COLUMN uploaded_at timestamptz NOT NULL DEFAULT now(),
        ADD COLUMN transcript text,
        ADD COLUMN source_type text NOT NULL DEFAULT 'uploaded',
        ADD COLUMN source_url text NOT NULL DEFAULT '',
        ADD COLUMN youtube_video_id text NOT NULL DEFAULT '',
        ADD COLUMN error_message text NOT NULL DEFAULT 'Old error';
      ALTER TABLE video_tags ADD COLUMN tag_id integer;
      CREATE TABLE tags (id integer, name text, color text);
      ALTER TABLE scene_embeddings ADD COLUMN langchain_metadata json;
      CREATE TABLE external_tasks (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        kind text NOT NULL, payload jsonb NOT NULL, dedupe_key text NOT NULL UNIQUE,
        attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
        locked_at timestamptz, completed_at timestamptz, dead_at timestamptz,
        effect_applied_at timestamptz, last_error text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await admin.query("UPDATE videos SET status = 'uploading', file = $1, transcript = $2 WHERE id = 10", [fileKey, originalTranscript]);
    vi.spyOn(media, "getR2ObjectSize").mockResolvedValue(4096);
    vi.spyOn(externalTasks, "processExternalTaskById").mockResolvedValue(true);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); }
  });

  async function tasks() {
    return (await admin.query("SELECT kind, payload FROM external_tasks ORDER BY id")).rows;
  }

  it("reads status and file together before atomically confirming and enqueueing", async () => {
    const query = vi.spyOn(pg.Client.prototype, "query");
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    await expect(confirmVideoUpload(env, 10, "owner")).resolves.toMatchObject({
      video: { id: 10, status: "pending", error_message: null }, alreadyConfirmed: false,
    });
    expect(connect).toHaveBeenCalledTimes(3); // Upload state, transaction, response.
    expect(query).toHaveBeenCalledTimes(6);
    query.mockRestore();
    expect(media.getR2ObjectSize).toHaveBeenCalledExactlyOnceWith(env, fileKey);
    expect(await tasks()).toEqual([{ kind: "sqs_job", payload: {
      message: expect.objectContaining({ type: "transcribe_video", payload: { video_id: 10 } }),
    } }]);
    expect(externalTasks.processExternalTaskById).toHaveBeenCalledTimes(1);
  });

  it.each(["pending", "processing", "indexing", "completed", "error"])("reuses a %s upload without another storage check or job", async status => {
    await admin.query("UPDATE videos SET status = $1 WHERE id = 10", [status]);
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    const query = vi.spyOn(pg.Client.prototype, "query");
    await expect(confirmVideoUpload(env, 10, "owner")).resolves.toMatchObject({
      video: { id: 10, status }, alreadyConfirmed: true,
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(2);
    query.mockRestore();
    expect(media.getR2ObjectSize).not.toHaveBeenCalled();
    expect(await tasks()).toEqual([]);
    expect(externalTasks.processExternalTaskById).not.toHaveBeenCalled();
  });

  it.each([20, 99])("hides foreign or missing video %i", async id => {
    await expect(confirmVideoUpload(env, id, "owner")).resolves.toEqual({ notFound: true });
    expect(media.getR2ObjectSize).not.toHaveBeenCalled();
    expect(await tasks()).toEqual([]);
  });

  it.each(["uploading", "pending"])("does not confirm a %s video without a file", async status => {
    await admin.query("UPDATE videos SET file = '', status = $1 WHERE id = 10", [status]);
    await expect(confirmVideoUpload(env, 10, "owner")).resolves.toMatchObject(
      status === "uploading" ? { notFound: true } : { badState: true },
    );
    expect(media.getR2ObjectSize).not.toHaveBeenCalled();
    expect(await tasks()).toEqual([]);
  });

  it("leaves an upload pending when its object has not arrived", async () => {
    vi.mocked(media.getR2ObjectSize).mockResolvedValueOnce(null);
    await expect(confirmVideoUpload(env, 10, "owner")).resolves.toMatchObject({ badState: true });
    expect((await admin.query("SELECT status FROM videos WHERE id = 10")).rows).toEqual([{ status: "uploading" }]);
    expect(await tasks()).toEqual([]);
  });

  it("deletes a mismatched upload and saves its cleanup without a transcription job", async () => {
    vi.mocked(media.getR2ObjectSize).mockResolvedValueOnce(8192);
    await expect(confirmVideoUpload(env, 10, "owner")).resolves.toMatchObject({ badState: true });
    expect((await admin.query("SELECT id FROM videos ORDER BY id")).rows).toEqual([{ id: 20 }]);
    expect(await tasks()).toEqual([expect.objectContaining({ kind: "storage_cleanup" })]);
  });

  it.each(["delete", "transfer", "replace", "replace-mismatch"])("does not confirm or delete a changed upload (%s) during the storage check", async change => {
    const replacement = "videos/owner/replacement_1700000000000_4096.mp4";
    vi.mocked(media.getR2ObjectSize).mockImplementationOnce(async () => {
      if (change === "delete") await admin.query("DELETE FROM videos WHERE id = 10");
      else if (change === "transfer") await admin.query("UPDATE videos SET user_id = 'outsider' WHERE id = 10");
      else await admin.query("UPDATE videos SET file = $1 WHERE id = 10", [replacement]);
      return change === "replace-mismatch" ? 8192 : 4096;
    });
    await expect(confirmVideoUpload(env, 10, "owner")).resolves.toMatchObject(
      change === "delete" || change === "transfer" ? { notFound: true } : { badState: true },
    );
    if (change !== "delete") {
      expect((await admin.query("SELECT user_id, status, file FROM videos WHERE id = 10")).rows).toEqual([{
        user_id: change === "transfer" ? "outsider" : "owner",
        status: "uploading", file: change === "transfer" ? fileKey : replacement,
      }]);
    }
    expect(await tasks()).toEqual([]);
    expect(externalTasks.processExternalTaskById).not.toHaveBeenCalled();
  });

  it("enqueues and dispatches only once for overlapping confirmations", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => confirmVideoUpload(env, 10, "owner")));
    expect(results.filter(result => "alreadyConfirmed" in result && !result.alreadyConfirmed)).toHaveLength(1);
    expect(results.every(result => "video" in result && result.video?.status === "pending")).toBe(true);
    expect(await tasks()).toHaveLength(1);
    expect(externalTasks.processExternalTaskById).toHaveBeenCalledTimes(1);
  });

  it("rolls back confirmation if its outbox insert fails", async () => {
    await admin.query(`
      CREATE FUNCTION reject_job() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'job rejected'; END $$;
      CREATE TRIGGER reject_job BEFORE INSERT ON external_tasks FOR EACH ROW EXECUTE FUNCTION reject_job();
    `);
    await expect(confirmVideoUpload(env, 10, "owner")).rejects.toThrow();
    expect((await admin.query("SELECT status, error_message FROM videos WHERE id = 10")).rows)
      .toEqual([{ status: "uploading", error_message: "Old error" }]);
    expect(await tasks()).toEqual([]);
    expect(externalTasks.processExternalTaskById).not.toHaveBeenCalled();
  });

  it("reports a missing video when it disappears before loading the response", async () => {
    vi.mocked(externalTasks.processExternalTaskById).mockImplementationOnce(async () => {
      await admin.query("DELETE FROM videos WHERE id = 10");
      return true;
    });
    await expect(confirmVideoUpload(env, 10, "owner")).resolves.toEqual({ notFound: true });
  });

  it.each([originalTranscript, originalTranscript.replace("Original", "Edited"), ""])("validates and saves subtitles without a separate ownership read: %j", async transcript => {
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    await expect(patchUserVideo(env, 10, "owner", { transcript })).resolves.toMatchObject({
      video: { id: 10, transcript: transcript || null },
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(await tasks()).toHaveLength(transcript === originalTranscript ? 0 : 1);
  });

  it("dispatches a committed reindex even if signing the update response fails", async () => {
    vi.spyOn(media, "resolveFileUrl").mockRejectedValue(new Error("Signing failed"));
    await expect(patchUserVideo(env, 10, "owner", { transcript: "" })).rejects.toThrow("Signing failed");
    expect(externalTasks.processExternalTaskById).toHaveBeenCalledTimes(1);
    expect(await tasks()).toEqual([{ kind: "sqs_job", payload: {
      message: expect.objectContaining({ type: "reindex_video_transcript", payload: { video_id: 10 } }),
    } }]);
    expect((await admin.query("SELECT transcript FROM videos WHERE id = 10")).rows).toEqual([{ transcript: "" }]);
  });

  it.each([10, 20, 99])("keeps subtitle validation errors behind ownership for video %i", async id => {
    await expect(patchUserVideo(env, id, "owner", { transcript: "invalid" })).resolves.toEqual(id === 10
      ? { fieldError: { transcript: [INVALID_SRT_MESSAGE] } }
      : { notFound: true });
    expect((await admin.query("SELECT transcript FROM videos WHERE id = 10")).rows).toEqual([{ transcript: originalTranscript }]);
    expect(await tasks()).toEqual([]);
  });
});
