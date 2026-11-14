import { expect, it } from "vitest";
import { createD1Fixture } from "./d1-fixture";
import { getMediaPathAccess } from "../../src/repositories/media-repository";
import { getVideoEvidence } from "../../src/repositories/video-evidence-repository";
import type { Bindings } from "../../src/types/bindings";

it("enforces owner, native membership, share and LMS isolation for D1 media and evidence", async () => {
  const { database, dispose } = await createD1Fixture();
  const env = { DB: database, DEPLOYMENT_EDITION: "cloud" } as Bindings;
  try {
    for (const id of ["owner", "learner", "other"]) {
      await database.prepare(`INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes)
        VALUES (?,?,?,0,0,0,0)`).bind(id, id, `${id}@example.test`).run();
    }
    await database.prepare(`INSERT INTO videos(id,user_id,file,title,description,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id)
      VALUES (1,'owner','lesson.mp4','Lesson','',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'字幕😀','completed','','uploaded','','')`).run();
    await database.prepare(`INSERT INTO video_courses(id,user_id,name,description,created_at,updated_at,display_order,share_slug)
      VALUES (1,'owner','Course','',?, ?,0,'public')`).bind(new Date().toISOString(), new Date().toISOString()).run();
    await database.prepare('INSERT INTO video_course_members(course_id,video_id,added_at,"order") VALUES (1,1,?,0)').bind(new Date().toISOString()).run();
    await database.prepare("INSERT INTO video_course_memberships(course_id,user_id,joined_at) VALUES (1,'learner',?)").bind(new Date().toISOString()).run();
    expect(await getMediaPathAccess(env, "lesson.mp4", { userId: "owner" })).toBe(true);
    expect(await getMediaPathAccess(env, "lesson.mp4", { userId: "learner" })).toBe(true);
    expect(await getMediaPathAccess(env, "lesson.mp4", { userId: "other" })).toBe(false);
    expect(await getMediaPathAccess(env, "lesson.mp4", { shareSlug: "public" })).toBe(true);
    expect(await getMediaPathAccess(env, "lesson.mp4", { shareSlug: "missing" })).toBeNull();
    expect(await getMediaPathAccess(env, "../lesson.mp4", { shareSlug: "public" })).toBe(false);
    expect(await getMediaPathAccess(env, "/lesson.mp4", { userId: "owner" })).toBe(false);
    for (const change of [
      "UPDATE video_courses SET managed_by_lms=1", "UPDATE video_courses SET managed_by_lms=0,native_access_disabled=1",
      "UPDATE video_courses SET native_access_disabled=0; UPDATE videos SET managed_by_lms=1",
    ]) {
      for (const statement of change.split(";")) await database.prepare(statement).run();
      expect(await getMediaPathAccess(env, "lesson.mp4", { shareSlug: "public" })).toBeNull();
      expect(await getMediaPathAccess(env, "lesson.mp4", { userId: "learner" })).toBe(false);
      expect(await getMediaPathAccess(env, "lesson.mp4", { userId: "owner" })).toBe(true);
    }
    expect(await getVideoEvidence(env, { ownerUserId: "owner", videoIds: [1] }, 1)).toMatchObject({ id: 1, transcript: "字幕😀", transcriptTooLarge: false });
    expect(await getVideoEvidence(env, { ownerUserId: "other", videoIds: [1] }, 1)).toBeNull();
    expect(await getVideoEvidence(env, { ownerUserId: "owner", videoIds: [] }, 1)).toBeNull();
    expect((await getVideoEvidence(env, { ownerUserId: "owner", videoIds: [1] }, 1))?.visualRunId).toBeNull();
    const visualRunId=crypto.randomUUID();
    await database.prepare("INSERT INTO video_visual_runs(video_id,run_id,file_key,duration_ms,chunk_count,status) VALUES (1,?,'lesson.mp4',60000,1,'processing')").bind(visualRunId).run();
    expect((await getVideoEvidence(env, { ownerUserId: "owner", videoIds: [1] }, 1))?.visualRunId).toBeNull();
    await database.prepare("UPDATE video_visual_runs SET status='ready'").run();
    expect((await getVideoEvidence(env, { ownerUserId: "owner", videoIds: [1] }, 1))?.visualRunId).toBe(visualRunId);
    await database.prepare("UPDATE videos SET status='processing' WHERE id=1").run();
    expect(await getVideoEvidence(env, { ownerUserId: "owner", videoIds: [1] }, 1)).toBeNull();
  } finally { await dispose(); }
}, 20_000);
