import { and, eq, sql } from "drizzle-orm";
import { multipartPartSize, MAX_UPLOAD_PARTS, isValidUploadPartEtag } from "@videoq/trpc/video-upload";
import { withDb } from "../../db/pool";
import { videos } from "../../db/schema";
import {
  abortR2MultipartUpload, completeR2MultipartUpload, createR2MultipartUpload,
  getR2ObjectSize, presignR2UploadPart,
} from "../../integrations/media";
import { buildJobMessage, JOB_TRANSCRIBE_VIDEO } from "../../lib/job-message";
import { parseReservedBytesFromFileKey } from "../../lib/upload";
import type { Bindings } from "../../types/bindings";
import { insertJobTask } from "./external-task-repository";

import {UploadSessionError,type MultipartUploadRepository} from "../contracts/multipart-upload-repository";
// Serialize control operations and deletion on the video row. Only small R2
// control requests run under this lock; video bytes travel browser -> R2.
export async function initializeMultipartUpload(
  env: Bindings, videoId: number, userId: string, contentType: string,
) {
  let created: { fileKey: string; uploadId: string } | undefined;
  try {
    return await withDb(env, db => db.transaction(async tx => {
      const [video] = await tx.select({ file: videos.file, status: videos.status, session: videos.multipartUpload })
        .from(videos).where(and(eq(videos.id, videoId), eq(videos.userId, userId))).for("update");
      if (!video) throw new UploadSessionError("Video not found", "NOT_FOUND");
      if (video.status !== "uploading") throw new UploadSessionError("Upload is already confirmed");
      const fileSize = parseReservedBytesFromFileKey(video.file);
      if (!fileSize) throw new UploadSessionError("Upload reservation is missing");
      let session = video.session;
      if (!session) {
        const uploadId = await createR2MultipartUpload(env, video.file, contentType);
        created = { fileKey: video.file, uploadId };
        session = { uploadId, contentType, partSize: multipartPartSize(fileSize) };
      }
      await tx.update(videos).set({ multipartUpload: session, uploadHeartbeatAt: sql`now()` }).where(eq(videos.id, videoId));
      return { part_size: session.partSize, part_count: Math.ceil(fileSize / session.partSize) };
    }));
  } catch (error) {
    if (created) {
      try {
        // A failed COMMIT response may still have persisted the session. Never
        // abort a resource which the database has already adopted.
        const candidate=created;
        const adopted=await withDb(env,async db=>(await db.select({id:videos.id}).from(videos)
          .where(and(eq(videos.file,candidate.fileKey),sql`${videos.multipartUpload}->>'uploadId'=${candidate.uploadId}`)).limit(1)).length>0);
        if(!adopted)await abortR2MultipartUpload(env,candidate.fileKey,candidate.uploadId);
      } catch { console.error(JSON.stringify({ event: "multipart_initialization_cleanup_failed", videoId })); }
    }
    throw error;
  }
}

export async function getMultipartUploadPartUrl(
  env: Bindings, videoId: number, userId: string, partNumber: number,
) {
  return withDb(env, db => db.transaction(async tx => {
    const [video] = await tx.select({ file: videos.file, status: videos.status, session: videos.multipartUpload })
      .from(videos).where(and(eq(videos.id, videoId), eq(videos.userId, userId))).for("update");
    if (!video) throw new UploadSessionError("Video not found", "NOT_FOUND");
    const session = video.session;
    if (video.status !== "uploading" || !session) throw new UploadSessionError("Multipart upload is not active");
    const size = parseReservedBytesFromFileKey(video.file);
    if (!size || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > Math.ceil(size / session.partSize)) {
      throw new UploadSessionError("Invalid upload part number");
    }
    const length = Math.min(session.partSize, size - (partNumber - 1) * session.partSize);
    const upload_url = await presignR2UploadPart(env, video.file, session.uploadId, partNumber, session.contentType, length);
    await tx.update(videos).set({ uploadHeartbeatAt: sql`now()` }).where(eq(videos.id, videoId));
    return { upload_url };
  }));
}

export async function completeMultipartVideoUpload(
  env: Bindings, videoId: number, userId: string, parts: { partNumber: number; etag: string }[],
): Promise<number | null> {
  return withDb(env, db => db.transaction(async tx => {
    const [video] = await tx.select({ file: videos.file, status: videos.status, session: videos.multipartUpload })
      .from(videos).where(and(eq(videos.id, videoId), eq(videos.userId, userId))).for("update");
    if (!video) throw new UploadSessionError("Video not found", "NOT_FOUND");
    if (["pending", "processing", "indexing", "completed", "error"].includes(video.status)) return null;
    const session = video.session;
    if (video.status !== "uploading" || !session) throw new UploadSessionError("Multipart upload is not active");
    const size = parseReservedBytesFromFileKey(video.file);
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    if (!size || parts.length > MAX_UPLOAD_PARTS || parts.length !== Math.ceil(size / session.partSize) ||
        ordered.some((part, index) => part.partNumber !== index + 1 || !isValidUploadPartEtag(part.etag))) {
      throw new UploadSessionError("Upload parts are missing or invalid");
    }
    // Recover if R2 completed but the response/DB commit was lost. A unique
    // reserved file key and signed part lengths bind this object to this upload.
    let actual = await getR2ObjectSize(env, video.file);
    if (actual === null) {
      try { await completeR2MultipartUpload(env, video.file, session.uploadId, ordered); }
      catch(error) { if(await getR2ObjectSize(env,video.file)!==size)throw error; }
      actual = await getR2ObjectSize(env, video.file);
    }
    if (actual !== size) throw new UploadSessionError("Uploaded object size does not match the reserved size");
    await tx.update(videos).set({
      status: "pending", errorMessage: "", multipartUpload: null, uploadHeartbeatAt: null,
    }).where(eq(videos.id, videoId));
    const message = buildJobMessage(JOB_TRANSCRIBE_VIDEO, { video_id: videoId });
    const task = await insertJobTask(tx, { message });
    return task.id;
  }));
}

export function createPostgresMultipartUploadRepository(env:Bindings):MultipartUploadRepository{return {
 initialize:(id,user,type)=>initializeMultipartUpload(env,id,user,type),partUrl:(id,user,part)=>getMultipartUploadPartUrl(env,id,user,part),complete:(id,user,parts)=>completeMultipartVideoUpload(env,id,user,parts),
 hasUploadingFile:file=>withDb(env,async db=>(await db.select({id:videos.id}).from(videos).where(and(eq(videos.file,file),eq(videos.status,'uploading'))).limit(1)).length>0),
 referencesFile:(file,upload)=>withDb(env,async db=>{const rows=await db.select({id:videos.id}).from(videos).where(and(eq(videos.file,file),upload===undefined?undefined:sql`${videos.multipartUpload}->>'uploadId'=${upload}`)).limit(1);return rows.length>0;}),
};}
